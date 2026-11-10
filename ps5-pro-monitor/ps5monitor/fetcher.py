"""HTTP-henting med høflig takt per nettsted, proxy-rotasjon, robots.txt og sperre-deteksjon.

Med en proxy-liste roterer hver forespørsel mellom flere utganger. Takten håndheves per
(proxy, nettsted), så hver enkelt IP holder seg innenfor `host_min_delay`, mens den samlede
oppdateringen kan gå raskere jo flere proxyer som er satt opp. En proxy som blir avvist eller
feiler settes midlertidig på pause, så den ikke sinker resten.
"""

from __future__ import annotations

import asyncio
import importlib.util
import re
import time
from dataclasses import dataclass, field
from urllib import robotparser
from urllib.parse import urlsplit

import httpx

_BLOCK_MARKERS = re.compile(
    r"attention required|just a moment|cf-chl|captcha|access denied|are you a robot|"
    r"er du en robot|unusual traffic|request blocked|bot detection", re.I)


@dataclass
class FetchResult:
    url: str
    final_url: str = ""
    status: int = 0
    text: str = ""
    error: str = ""
    blocked: bool = False
    retry_after: float = 0.0
    proxy: str = ""  # hvilken utgang (proxy-etikett) som ble brukt

    @property
    def ok(self) -> bool:
        return self.status == 200 and not self.blocked and not self.error

    @property
    def gone(self) -> bool:
        return self.status in (404, 410)

    @property
    def redirected(self) -> bool:
        return bool(self.final_url) and _strip(self.final_url) != _strip(self.url)

    def reason(self) -> str:
        if self.error:
            return self.error
        if self.blocked:
            return f"butikken avviser automatiske forespørsler (HTTP {self.status})"
        return f"HTTP {self.status}"


def _strip(url: str) -> str:
    parts = urlsplit(url)
    host = parts.netloc.lower().removeprefix("www.").split(":")[0]
    return host + parts.path.rstrip("/")


def host_of(url: str) -> str:
    return urlsplit(url).netloc.lower()


def proxy_label(url: str) -> str:
    """Kort, trygt navn på en proxy – uten brukernavn/passord."""
    parts = urlsplit(url if "://" in url else "http://" + url)
    host = parts.hostname or url
    return f"{host}:{parts.port}" if parts.port else host


@dataclass
class _Outlet:
    """Én utgang: direkte forbindelse eller én proxy."""
    index: int
    label: str
    client: httpx.AsyncClient
    fails: int = 0
    cooldown_until: float = 0.0


@dataclass
class FetcherStats:
    requests: dict[str, int] = field(default_factory=dict)

    def note(self, label: str) -> None:
        self.requests[label] = self.requests.get(label, 0) + 1


class Fetcher:
    def __init__(self, *, user_agent: str, timeout: float = 25, host_min_delay: float = 4,
                 respect_robots: bool = True, proxies: list[str] | tuple[str, ...] = (),
                 include_direct: bool | None = None,
                 transport: httpx.AsyncBaseTransport | None = None,
                 clock=time.monotonic, sleeper=asyncio.sleep, warn=None):
        self.user_agent = user_agent
        self.host_min_delay = host_min_delay
        self.respect_robots = respect_robots
        self._clock = clock
        self._sleep = sleeper
        self._warn = warn or (lambda _m: None)
        self.stats = FetcherStats()
        self._headers = {
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5",
        }
        self._timeout = httpx.Timeout(timeout, connect=min(timeout, 15))
        self._transport = transport
        self._http2 = importlib.util.find_spec("h2") is not None and transport is None
        self.outlets = self._build_outlets(proxies, include_direct)
        self._next_allowed: dict[tuple[int, str], float] = {}
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._robots: dict[str, tuple[float, robotparser.RobotFileParser | None]] = {}
        self._rr = 0

    # ------------------------------------------------------------------ oppsett
    def _new_client(self, proxy: str | None) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            http2=self._http2, follow_redirects=True, timeout=self._timeout,
            transport=self._transport,
            proxy=proxy if self._transport is None else None,
            headers=self._headers)

    def _build_outlets(self, proxies, include_direct: bool | None) -> list[_Outlet]:
        proxies = list(dict.fromkeys(p for p in proxies if p))
        if include_direct is None:
            include_direct = not proxies
        specs: list[tuple[str, str | None]] = []
        if include_direct or not proxies:
            specs.append(("direkte", None))
        specs += [(proxy_label(p), p) for p in proxies]

        outlets: list[_Outlet] = []
        for label, proxy in specs:
            # Gjør etiketten unik så takten per utgang ikke blandes sammen.
            unique = label
            n = 2
            while any(o.label == unique for o in outlets):
                unique = f"{label}#{n}"
                n += 1
            try:
                client = self._new_client(proxy)
            except Exception as exc:  # f.eks. socks-proxy uten httpx[socks]
                self._warn(f"Kan ikke bruke proxy {label}: {type(exc).__name__}: {exc}")
                continue
            outlets.append(_Outlet(len(outlets), unique, client))
        if not outlets:  # alle proxyer feilet – fall tilbake til direkte forbindelse
            outlets.append(_Outlet(0, "direkte", self._new_client(None)))
        return outlets

    async def close(self) -> None:
        for outlet in self.outlets:
            try:
                await outlet.client.aclose()
            except Exception:
                pass

    # ------------------------------------------------------------------ valg av utgang
    def _select(self, host: str, now: float) -> tuple[_Outlet, float]:
        """Velger utgangen som har ventet lengst på dette nettstedet.

        Proxyer i pause hoppes over så lenge andre er klare; er alle i pause, brukes den som
        snart er klar igjen (men vi venter ikke ut hele pausen – bare den vanlige takten).
        Returnerer (utgang, sekunder å vente før forespørselen kan sendes).
        """
        def spacing(o: _Outlet) -> float:
            return self._next_allowed.get((o.index, host), 0.0)

        ready = [o for o in self.outlets if o.cooldown_until <= now]
        if not ready:
            outlet = min(self.outlets, key=lambda o: o.cooldown_until)
            return outlet, max(0.0, spacing(outlet) - now)

        soonest = min(spacing(o) for o in ready)
        tied = [o for o in ready if spacing(o) <= soonest + 1e-9]
        outlet = tied[self._rr % len(tied)]
        self._rr += 1
        return outlet, max(0.0, spacing(outlet) - now)

    def _note_health(self, outlet: _Outlet, result: FetchResult) -> None:
        if result.blocked or result.error:
            outlet.fails += 1
            backoff = min(300.0, 10.0 * 2 ** min(outlet.fails, 5))
            outlet.cooldown_until = self._clock() + backoff
            if len(self.outlets) > 1:
                self._warn(f"Proxy {outlet.label}: {result.reason()} – pauses i "
                           f"{int(backoff)} s.")
        elif not result.error and not result.blocked:
            outlet.fails = 0
            outlet.cooldown_until = 0.0

    # ------------------------------------------------------------------ forespørsel
    async def _request(self, outlet: _Outlet, url: str) -> FetchResult:
        result = FetchResult(url=url, proxy=outlet.label)
        try:
            resp = await outlet.client.get(url)
        except httpx.TimeoutException:
            result.error = "tidsavbrudd"
            return result
        except (httpx.HTTPError, httpx.InvalidURL, OSError) as exc:
            result.error = f"nettverksfeil: {type(exc).__name__}"
            return result
        result.status = resp.status_code
        result.final_url = str(resp.url)
        try:
            result.text = resp.text
        except Exception:
            result.text = resp.content.decode("utf-8", errors="replace")
        retry = resp.headers.get("retry-after", "")
        if retry.isdigit():
            result.retry_after = float(retry)
        head = result.text[:6000]
        if resp.status_code in (401, 403, 429) or (
                resp.status_code in (200, 503) and len(result.text) < 20000
                and _BLOCK_MARKERS.search(head)):
            result.blocked = True
        return result

    async def _timed_request(self, url: str) -> FetchResult:
        host = host_of(url)
        lock = self._host_locks.setdefault(host, asyncio.Lock())
        async with lock:
            now = self._clock()
            outlet, wait = self._select(host, now)
            # Reserver tiden synkront (før eventuell venting) så andre nettsteder som deler
            # samme proxy ser reservasjonen med en gang.
            self._next_allowed[(outlet.index, host)] = now + wait + self.host_min_delay
            if wait > 0:
                await self._sleep(wait)
            result = await self._request(outlet, url)
        self.stats.note(outlet.label)
        self._note_health(outlet, result)
        return result

    async def allowed(self, url: str) -> bool:
        """Sjekker robots.txt (hentes på nytt én gang i døgnet per nettsted)."""
        if not self.respect_robots:
            return True
        parts = urlsplit(url)
        host = parts.netloc.lower()
        cached = self._robots.get(host)
        if cached is None or self._clock() - cached[0] > 86400:
            parser = None
            res = await self._timed_request(f"{parts.scheme}://{parts.netloc}/robots.txt")
            if res.status == 200 and not res.blocked and "<html" not in res.text[:500].lower():
                parser = robotparser.RobotFileParser()
                parser.parse(res.text.splitlines())
            self._robots[host] = (self._clock(), parser)
            cached = self._robots[host]
        parser = cached[1]
        if parser is None:
            return True
        try:
            return parser.can_fetch(self.user_agent, url)
        except Exception:
            return True

    async def get(self, url: str) -> FetchResult:
        if not await self.allowed(url):
            return FetchResult(url=url, error="ikke tillatt av butikkens robots.txt")
        return await self._timed_request(url)

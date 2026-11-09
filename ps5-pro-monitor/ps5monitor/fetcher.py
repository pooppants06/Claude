"""HTTP-henting med høflig takt per nettsted, robots.txt-sjekk og gjenkjenning av sperrer."""

from __future__ import annotations

import asyncio
import importlib.util
import re
import time
from dataclasses import dataclass
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


class Fetcher:
    def __init__(self, *, user_agent: str, timeout: float = 25, host_min_delay: float = 4,
                 respect_robots: bool = True, transport: httpx.AsyncBaseTransport | None = None):
        self.user_agent = user_agent
        self.host_min_delay = host_min_delay
        self.respect_robots = respect_robots
        http2 = importlib.util.find_spec("h2") is not None  # HTTP/2 hvis pakken er installert
        self.client = httpx.AsyncClient(
            http2=http2 and transport is None,
            follow_redirects=True,
            timeout=httpx.Timeout(timeout, connect=min(timeout, 15)),
            transport=transport,
            headers={
                "User-Agent": user_agent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5",
            },
        )
        self._locks: dict[str, asyncio.Lock] = {}
        self._last: dict[str, float] = {}
        self._robots: dict[str, tuple[float, robotparser.RobotFileParser | None]] = {}

    async def close(self) -> None:
        await self.client.aclose()

    async def _throttle(self, host: str) -> None:
        wait = self._last.get(host, 0) + self.host_min_delay - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._last[host] = time.monotonic()

    async def _request(self, url: str) -> FetchResult:
        result = FetchResult(url=url)
        try:
            resp = await self.client.get(url)
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

    async def allowed(self, url: str) -> bool:
        """Sjekker robots.txt (hentes på nytt én gang i døgnet per nettsted)."""
        if not self.respect_robots:
            return True
        parts = urlsplit(url)
        host = parts.netloc.lower()
        cached = self._robots.get(host)
        if cached is None or time.monotonic() - cached[0] > 86400:
            parser = None
            lock = self._locks.setdefault(host, asyncio.Lock())
            async with lock:
                await self._throttle(host)
                res = await self._request(f"{parts.scheme}://{parts.netloc}/robots.txt")
            if res.status == 200 and not res.blocked and "<html" not in res.text[:500].lower():
                parser = robotparser.RobotFileParser()
                parser.parse(res.text.splitlines())
            self._robots[host] = (time.monotonic(), parser)
            cached = self._robots[host]
        parser = cached[1]
        if parser is None:
            return True
        try:
            return parser.can_fetch(self.user_agent, url)
        except Exception:
            return True

    async def get(self, url: str) -> FetchResult:
        host = host_of(url)
        if not await self.allowed(url):
            return FetchResult(url=url, error="ikke tillatt av butikkens robots.txt")
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            await self._throttle(host)
            return await self._request(url)

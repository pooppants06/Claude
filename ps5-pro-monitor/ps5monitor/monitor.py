"""Selve overvåkingen: tidsplan per nettsted, endringsdeteksjon, oppdagelse av nye sider."""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import unquote, urljoin, urlsplit

from . import notify
from .config import Aggregator, Config, Store
from .extract import collect_signals, reconcile
from .extract import prisjakt
from .fetcher import Fetcher, FetchResult, _strip, host_of
from .htmldoc import HtmlDoc
from .models import Availability, Observation
from .state import State, now_iso

log = logging.getLogger("ps5monitor")

MAX_DISCOVERED_PER_OWNER = 20


@dataclass
class Target:
    kind: str  # product | listing | agg_product | agg_listing
    url: str
    owner: Store | Aggregator
    interval: float
    next_due: float = 0.0
    fails: int = 0
    checked: bool = False
    discovered: bool = False
    disabled: bool = False

    @property
    def host(self) -> str:
        return host_of(self.url)


def item_key(owner_id: str, url: str) -> str:
    return f"{owner_id}|{_strip(url)}"


class Monitor:
    def __init__(self, cfg: Config, state: State, fetcher: Fetcher, notifier: notify.Notifier,
                 *, rng: random.Random | None = None):
        self.cfg, self.state, self.fetcher, self.notifier = cfg, state, fetcher, notifier
        self.rng = rng or random.Random()
        self.s = cfg.settings
        self.targets: list[Target] = []
        self.first_run = state.first_run
        self.started = time.monotonic()
        self.checks = 0
        self._workers: dict[str, asyncio.Task] = {}
        self._wake: dict[str, asyncio.Event] = {}
        self._running = False
        self._build_targets()

    # ------------------------------------------------------------------ oppsett
    def _build_targets(self) -> None:
        for store in self.cfg.stores:
            interval = store.interval or self.s.interval_seconds
            for url in store.products:
                self._add_target(Target("product", url, store, interval))
            for url in self.state.discovered.get(store.id, []):
                self._add_target(Target("product", url, store, interval, discovered=True))
            if self.s.auto_discover:
                for url in store.listings:
                    self._add_target(Target("listing", url, store,
                                            self.s.listing_interval_seconds))
        for agg in self.cfg.aggregators:
            interval = agg.interval or self.s.aggregator_interval_seconds
            for url in agg.products:
                self._add_target(Target("agg_product", url, agg, interval))
            for url in self.state.discovered.get(agg.id, []):
                self._add_target(Target("agg_product", url, agg, interval, discovered=True))
            if self.s.auto_discover:
                for url in agg.listings:
                    self._add_target(Target("agg_listing", url, agg,
                                            self.s.listing_interval_seconds))

    def _find_target(self, url: str) -> Target | None:
        wanted = _strip(url) + "?" + urlsplit(url).query
        for t in self.targets:
            if _strip(t.url) + "?" + urlsplit(t.url).query == wanted:
                return t
        return None

    def _add_target(self, target: Target) -> bool:
        if self._find_target(target.url) is not None:
            return False
        # Spre første sjekk litt så ikke alt går samtidig.
        target.next_due = time.monotonic() + self.rng.uniform(0, 2)
        self.targets.append(target)
        if self._running:
            self._ensure_worker(target.host)
            self._wake[target.host].set()
        return True

    # ------------------------------------------------------------------ kjøring
    async def run_once(self) -> None:
        """Sjekker alle mål én gang (inkludert sider som oppdages underveis)."""
        seen: set[int] = set()
        while True:
            batch = [t for t in self.targets if id(t) not in seen and not t.disabled]
            if not batch:
                break
            seen.update(id(t) for t in batch)
            by_host: dict[str, list[Target]] = {}
            for t in batch:
                by_host.setdefault(t.host, []).append(t)

            async def run_host(targets: list[Target]) -> None:
                for t in targets:
                    await self.check(t)

            await asyncio.gather(*(run_host(ts) for ts in by_host.values()))
            # Endringer må bekreftes før de varsles – sjekk de aktuelle sidene på nytt.
            for _round in range(self.s.confirmations - 1):
                pending = [t for t in batch if not t.disabled and self._has_pending(t)]
                if not pending:
                    break
                await asyncio.sleep(self.s.confirm_delay_seconds)
                for t in pending:
                    await self.check(t)

    def _has_pending(self, target: Target) -> bool:
        item = self.state.item(item_key(target.owner.id, target.url))
        return bool(item and item.get("pending")) or any(
            i.get("pending") for i in self.state.items.values()
            if i.get("source_url") == target.url)

    async def run(self) -> None:
        self._running = True
        for host in {t.host for t in self.targets}:
            self._ensure_worker(host)
        aux = [asyncio.create_task(self._housekeeping(), name="housekeeping"),
               asyncio.create_task(self.notifier.worker(), name="notifier")]
        if self.notifier.telegram and self.cfg.telegram.commands:
            aux.append(asyncio.create_task(
                self.notifier.telegram.poll_commands(self.handle_command), name="telegram"))
        try:
            await asyncio.gather(*aux)
        finally:
            self._running = False
            for task in [*self._workers.values(), *aux]:
                task.cancel()
            self.state.save(force=True)

    def _ensure_worker(self, host: str) -> None:
        if host not in self._workers or self._workers[host].done():
            self._wake.setdefault(host, asyncio.Event())
            self._workers[host] = asyncio.create_task(self._host_loop(host), name=f"host:{host}")

    async def _host_loop(self, host: str) -> None:
        """Én arbeider per nettsted: sidene der sjekkes etter tur, aldri parallelt."""
        wake = self._wake[host]
        while True:
            mine = [t for t in self.targets if t.host == host and not t.disabled]
            if not mine:
                return
            target = min(mine, key=lambda t: t.next_due)
            delay = target.next_due - time.monotonic()
            if delay > 0:
                wake.clear()
                try:
                    await asyncio.wait_for(wake.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
                continue
            try:
                await self.check(target)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Uventet feil ved sjekk av %s", target.url)
                target.next_due = time.monotonic() + target.interval
            self.state.save()

    async def _housekeeping(self) -> None:
        summary_sent = False
        next_daily = self._next_daily()
        next_beat = 0.0
        next_log = time.monotonic() + 600
        deadline = time.monotonic() + 240
        while True:
            await asyncio.sleep(1)
            now = time.monotonic()
            try:
                self._revive_workers()
                if not summary_sent and (all(t.checked or t.disabled for t in self.targets)
                                         or now > deadline):
                    summary_sent = True
                    self._finish_first_pass()
                if now >= next_log:  # livstegn i loggen så det synes at vakten jobber
                    next_log = now + 600
                    buyable = sum(1 for i in self.state.items.values() if not i.get("covered")
                                  and Availability(i.get("availability", "unknown")).buyable)
                    log.info("Kjører: %d sjekker utført, %d oppføringer kan kjøpes, %d butikker "
                             "med feil.", self.checks, buyable, len(self.stores_down()))
                if next_daily and datetime.now() >= next_daily:
                    next_daily = self._next_daily()
                    self.notifier.post(self.summary())
            except Exception:
                log.exception("Uventet feil i vedlikeholdsløkka")
            if self.s.heartbeat_url and now >= next_beat:
                next_beat = now + max(30.0, self.s.heartbeat_interval_seconds)
                try:
                    await self.notifier.client.get(self.s.heartbeat_url, timeout=10)
                except Exception:
                    log.debug("Klarte ikke å pinge heartbeat_url")

    def _revive_workers(self) -> None:
        """Starter en nettsted-arbeider på nytt hvis den har stoppet av en uventet feil."""
        for host in {t.host for t in self.targets if not t.disabled}:
            worker = self._workers.get(host)
            if worker is not None and worker.done() and not worker.cancelled() \
                    and worker.exception() is not None:
                log.error("Arbeideren for %s stoppet (%r) – starter den på nytt.", host,
                          worker.exception())
            self._ensure_worker(host)

    def _finish_first_pass(self) -> None:
        self.first_run = False
        self.state.first_run = False
        # Butikker som feiler allerede nå står i oppsummeringen; ikke varsle dem på nytt.
        for info in self.state.stores.values():
            if info.get("failing") and not info.get("down"):
                info.update(down=True, since=now_iso(),
                            reason=next(iter(info["failing"].values())))
        if self.s.startup_summary:
            self.notifier.post(self.summary("🚀 PS5 Pro-vakten er i gang"))
        self.state.save(force=True)

    def _next_daily(self) -> datetime | None:
        m = re.fullmatch(r"\s*(\d{1,2})[:.](\d{2})\s*", self.s.daily_summary or "")
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            return None
        now = datetime.now()
        at = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        return at if at > now else at + timedelta(days=1)

    # ------------------------------------------------------------------ én sjekk
    async def check(self, target: Target) -> None:
        result = await self.fetcher.get(target.url)
        target.checked = True
        self.checks += 1
        process = {"product": self._process_product,
                   "agg_product": self._process_agg_product}.get(target.kind,
                                                                 self._process_listing)
        try:
            ok = process(target, result)
        except Exception:  # én side med uventet innhold skal ikke stoppe resten
            log.exception("Uventet feil ved behandling av %s", target.url)
            ok = False
        self._reschedule(target, ok, result)

    def _reschedule(self, target: Target, ok: bool, result: FetchResult) -> None:
        now = time.monotonic()
        if ok:
            target.fails = 0
            if self._has_pending(target):
                target.next_due = now + self.s.confirm_delay_seconds
                return
            jitter = 1 + self.rng.uniform(-self.s.jitter, self.s.jitter)
            target.next_due = now + target.interval * jitter
        else:
            target.fails += 1
            backoff = target.interval * (2 ** min(target.fails, 6))
            backoff = max(backoff, result.retry_after)
            target.next_due = now + min(backoff, self.s.max_backoff_seconds)

    # ------------------------------------------------------------------ butikkhelse
    def _store_result(self, owner: Store | Aggregator, target: Target, ok: bool,
                      reason: str = "") -> None:
        info = self.state.stores.setdefault(owner.id, {"name": owner.name, "down": False})
        info["name"] = owner.name
        failing: dict = info.setdefault("failing", {})
        if ok:
            failing.pop(target.url, None)
            if info.get("down") and not failing:
                info["down"] = False
                info.pop("reason", None)
                self.state.log_event({"event": "store_up", "store": owner.name})
                if self.s.notify_store_health and not self.first_run:
                    self.notifier.post(notify.store_health_message(owner.name, False))
        else:
            failing[target.url] = reason
            # target.fails økes etter denne sjekken, derfor +1.
            if not info.get("down") and target.fails + 1 >= self.s.fail_threshold:
                info["down"] = True
                info["reason"] = reason
                info["since"] = now_iso()
                self.state.log_event({"event": "store_down", "store": owner.name,
                                      "reason": reason})
                if self.s.notify_store_health and not self.first_run:
                    self.notifier.post(notify.store_health_message(owner.name, True, reason))
        self.state.touch()

    def stores_down(self) -> dict[str, str]:
        """Butikker med aktive feil akkurat nå (vises i oppsummeringen)."""
        out = {}
        for info in self.state.stores.values():
            failing = info.get("failing") or {}
            if failing:
                reasons = sorted(set(failing.values()))
                out[info.get("name", "?")] = reasons[0] + (
                    f" ({len(failing)} sider)" if len(failing) > 1 else "")
        return out

    # ------------------------------------------------------------------ produktsider
    def _process_product(self, target: Target, result: FetchResult) -> bool:
        store: Store = target.owner  # type: ignore[assignment]
        key = item_key(store.id, target.url)
        item = self.state.item(key)

        if not result.ok and not result.gone:
            reason = result.reason()
            log.warning("%s: %s (%s)", store.name, reason, target.url)
            if item is not None:
                item["error"] = reason
                item["last_checked"] = now_iso()
            self._store_result(store, target, False, reason)
            return False

        sku = store.sku_from_url(target.url)
        if result.gone:
            obs = Observation(availability=Availability.DISCONTINUED,
                              detail=f"siden finnes ikke lenger (HTTP {result.status})")
        else:
            moved = self._handle_redirect(target, result, store, sku, key)
            if moved == "alias":
                return True
            if moved == "removed":
                obs = Observation(availability=Availability.DISCONTINUED,
                                  detail="siden er fjernet (videresendt)")
            else:
                signals = collect_signals(result.text, extractor=store.extractor,
                                          markers=store.markers, sku=sku)
                obs = reconcile(signals)

        if obs.availability is Availability.UNKNOWN and obs.price is None:
            reason = "fant verken pris eller lagerstatus i kildekoden (endret sideoppsett?)"
            log.warning("%s: %s (%s)", store.name, reason, target.url)
            if item is not None:
                item["error"] = reason
                item["last_checked"] = now_iso()
            self._store_result(store, target, False, reason)
            return False

        # En automatisk oppdaget side som viser seg å være noe annet (tilbehør) forkastes.
        if target.discovered and item is None and obs.name and not self.cfg.is_wanted(obs.name):
            log.info("Forkaster %s («%s» er ikke %s)", target.url, obs.name,
                     self.cfg.product_name)
            self._reject(store.id, target)
            return True

        self._store_result(store, target, True)
        if item is None:
            item = self._new_item(key, "product", store.id, store.name, target.url)
            item["discovered"] = target.discovered
            self._apply(item, obs, is_new=True)
        else:
            self._apply(item, obs)
        item["sku"] = obs.sku or sku or item.get("sku")
        return True

    def _handle_redirect(self, target: Target, result: FetchResult, store: Store,
                         sku: str | None, key: str) -> str | None:
        if not result.redirected:
            return None
        other = self._find_target(result.final_url)
        if other is not None and other is not target and other.kind == "product":
            log.info("%s videresender til %s – overvåkes allerede der.", target.url, other.url)
            self.state.items.pop(key, None)
            if target.discovered:
                self._reject(store.id, target)
            target.disabled = True
            self.state.touch()
            return "alias"
        new_sku = store.sku_from_url(result.final_url)
        if sku and new_sku != sku:
            if new_sku and self.cfg.is_wanted(unquote(urlsplit(result.final_url).path)):
                self._discover(store, result.final_url)
            return "removed"
        return None

    def _reject(self, owner_id: str, target: Target) -> None:
        target.disabled = True
        rejected = self.state.meta.setdefault("rejected", [])
        if target.url not in rejected:
            rejected.append(target.url)
        urls = self.state.discovered.get(owner_id, [])
        if target.url in urls:
            urls.remove(target.url)
        self.state.touch()

    def _new_item(self, key: str, kind: str, store_id: str, store: str, url: str) -> dict:
        item = {
            "key": key, "kind": kind, "store_id": store_id, "store": store, "url": url,
            "name": None, "sku": None, "availability": Availability.UNKNOWN.value,
            "price": None, "detail": None, "first_seen": now_iso(), "last_changed": now_iso(),
            "pending": None, "error": None,
        }
        self.state.items[key] = item
        return item

    # ------------------------------------------------------------------ endringer
    def _apply(self, item: dict, obs: Observation, *, is_new: bool = False,
               silent: bool = False) -> str | None:
        """Sammenligner ny observasjon med lagret status. Returnerer type endring, om noen.

        En endring må sees `confirmations` ganger på rad før den lagres og varsles, slik at
        cache-blaff og halvlastede sider ikke gir falske varsler.
        """
        now = now_iso()
        item["last_checked"] = item["last_ok"] = now
        item["error"] = None
        if obs.name:
            item["name"] = obs.name
        if obs.signals:
            item["sources"] = {s.source: s.brief() for s in obs.signals if not s.empty}
            item["sources_summary"] = obs.sources_summary()
        item["conflict"] = obs.conflict
        self.state.touch()

        old_av = Availability(item["availability"])
        old_price = item.get("price")
        new_av = obs.availability if obs.availability is not Availability.UNKNOWN else old_av
        new_price = obs.price if obs.price is not None else old_price

        if is_new:
            item.update(availability=new_av.value, price=new_price, detail=obs.detail)
            self.state.log_event({"event": "new", "store": item["store"], "url": item["url"],
                                  "name": item.get("name"), "availability": new_av.value,
                                  "price": new_price})
            if not self.first_run and not silent and self.s.notify_new_listings:
                self.notifier.post(notify.new_listing_message(item))
            return "new"

        price_changed = (old_price is None) != (new_price is None) or (
            old_price is not None and new_price is not None
            and abs(new_price - old_price) >= 0.005)
        if new_av is old_av and not price_changed:
            item["pending"] = None
            if new_av is not Availability.UNKNOWN:
                item["detail"] = obs.detail
            return None

        pending = item.get("pending") or {}
        if pending.get("availability") == new_av.value and pending.get("price") == new_price:
            pending["count"] = pending.get("count", 1) + 1
        else:
            pending = {"availability": new_av.value, "price": new_price, "count": 1}
        item["pending"] = pending
        if pending["count"] < self.s.confirmations:
            log.info("%s: mulig endring (%s, %s) – bekrefter …", item["store"], new_av.label,
                     new_price)
            return None

        # Bekreftet.
        item.update(availability=new_av.value, price=new_price, detail=obs.detail,
                    pending=None, last_changed=now)
        kind = self._classify(old_av, new_av, old_price, new_price)
        self.state.log_event({
            "event": kind or "update", "store": item["store"], "url": item["url"],
            "name": item.get("name"), "from": old_av.value, "to": new_av.value,
            "old_price": old_price, "price": new_price, "via": item.get("via")})
        if kind and not silent and self._should_notify(kind):
            self.notifier.post(notify.change_message(item, kind, old_av.value, old_price))
        return kind

    def _classify(self, old_av: Availability, new_av: Availability,
                  old_price: float | None, new_price: float | None) -> str | None:
        if new_av.buyable and not old_av.buyable:
            return "restock"
        if old_av.buyable and not new_av.buyable:
            return "sold_out"
        if new_av is not old_av and old_av is not Availability.UNKNOWN:
            # F.eks. forhåndsbestilling -> på lager er like viktig som en påfylling.
            return "restock" if new_av is Availability.IN_STOCK else "status"
        if old_price is not None and new_price is not None:
            diff = new_price - old_price
            if abs(diff) >= max(self.s.min_price_change, 0.005):
                return "price_drop" if diff < 0 else "price_up"
        return None

    def _should_notify(self, kind: str) -> bool:
        if kind == "sold_out":
            return self.s.notify_sold_out
        if kind in ("price_drop", "price_up"):
            return self.s.notify_price_changes
        return True

    # ------------------------------------------------------------------ oppdagelse
    def _discover(self, owner: Store | Aggregator, url: str) -> bool:
        if url in self.state.meta.get("rejected", []):
            return False
        known = self.state.discovered.setdefault(owner.id, [])
        if len(known) >= MAX_DISCOVERED_PER_OWNER:
            return False
        kind = "product" if isinstance(owner, Store) else "agg_product"
        interval = owner.interval or (self.s.interval_seconds if kind == "product"
                                      else self.s.aggregator_interval_seconds)
        if not self._add_target(Target(kind, url, owner, interval, discovered=True)):
            return False
        known.append(url)
        self.state.touch()
        log.info("Oppdaget ny side hos %s: %s", owner.name, url)
        return True

    def _process_listing(self, target: Target, result: FetchResult) -> bool:
        owner = target.owner
        if not result.ok:
            log.info("%s: oversiktsside ikke tilgjengelig (%s)", owner.name, result.reason())
            return False
        doc = HtmlDoc(result.text)
        base = result.final_url or target.url
        host = host_of(base).removeprefix("www.")
        candidates: dict[str, str] = {}
        for href, text in doc.links:
            candidates.setdefault(href, text)
        # Mange butikker legger produktlistene i JSON i stedet for <a>-lenker.
        for m in re.finditer(r'"(?:url|href|link|productLink)"\s*:\s*"([^"\\]{8,300})"',
                             result.text.replace("\\/", "/").replace("&quot;", '"')):
            candidates.setdefault(m.group(1), "")

        found = 0
        for href, text in candidates.items():
            url = urljoin(base, href.strip())
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https"):
                continue
            if parts.netloc.lower().removeprefix("www.") != host:
                continue
            is_store = isinstance(owner, Store)
            if owner.link_regex:
                if not re.search(owner.link_regex, parts.path + ("?" + parts.query
                                                                 if parts.query else "")):
                    continue
            elif is_store and owner.sku_regex and not owner.sku_from_url(url):
                continue
            # Behold bare spørringen når den identifiserer produktet (f.eks. product.php?p=…).
            keep_query = bool(owner.link_regex and "?" in owner.link_regex)
            clean = f"{parts.scheme}://{parts.netloc}{parts.path}" + (
                f"?{parts.query}" if keep_query and parts.query else "")
            # Lenketeksten er best når den faktisk er et produktnavn; ellers brukes URL-en.
            if text and self.cfg.mentions(text):
                wanted = self.cfg.is_wanted(text)
            else:
                wanted = any(self.cfg.is_wanted(seg) for seg in unquote(parts.path).split("/"))
            if not wanted:
                continue
            if self._discover(owner, clean):
                found += 1
        if found:
            log.info("%s: %d ny(e) side(r) lagt til overvåking.", owner.name, found)
        return True

    # ------------------------------------------------------------------ Prisjakt
    def _store_covers(self, shop: str, offer_id: str) -> bool:
        """Sann hvis butikken overvåkes direkte, er frisk, og dette tilbudet er en side vi har."""
        store = self.cfg.store_for_shop(shop)
        if store is None or (self.state.stores.get(store.id) or {}).get("failing"):
            return False
        for item in self.state.items.values():
            if item.get("store_id") != store.id or item.get("kind") != "product":
                continue
            if offer_id and offer_id in (str(item.get("sku") or ""),
                                         str(store.sku_from_url(item["url"]) or "")):
                return True
        return False

    def _process_agg_product(self, target: Target, result: FetchResult) -> bool:
        agg: Aggregator = target.owner  # type: ignore[assignment]
        if not result.ok:
            reason = result.reason()
            log.warning("%s: %s (%s)", agg.name, reason, target.url)
            self._store_result(agg, target, False, reason)
            return False
        doc = HtmlDoc(result.text)
        offers = prisjakt.parse_offers(doc)
        if offers is None:
            reason = "fant ikke tilbudslisten i kildekoden (endret sideoppsett?)"
            log.warning("%s: %s (%s)", agg.name, reason, target.url)
            self._store_result(agg, target, False, reason)
            return False
        title = prisjakt.product_title(doc)
        if target.discovered and title and not self.cfg.is_wanted(title):
            self._reject(agg.id, target)
            return True
        self._store_result(agg, target, True)

        prefix = item_key(agg.id, target.url) + "?" + urlsplit(target.url).query + "|"
        first_time = not any(k.startswith(prefix) for k in self.state.items)
        seen: set[str] = set()
        for offer in offers:
            if offer.condition not in ("new", ""):
                continue
            key = prefix + offer.key
            seen.add(key)
            covered = self._store_covers(offer.shop, offer.offer_id)
            obs = Observation(availability=offer.availability, price=offer.price,
                              name=offer.name or title)
            item = self.state.item(key)
            if item is None:
                item = self._new_item(key, "offer", agg.id, offer.shop, target.url)
                item.update(via=agg.name, source_url=target.url, sku=offer.offer_id)
                item["covered"] = covered
                self._apply(item, obs, is_new=True, silent=covered or first_time)
            else:
                item["covered"] = covered
                self._apply(item, obs, silent=covered)
        # Tilbud som har forsvunnet fra listen regnes som utsolgt.
        for key, item in self.state.items.items():
            if key.startswith(prefix) and key not in seen and \
                    Availability(item["availability"]).buyable:
                self._apply(item, Observation(availability=Availability.OUT_OF_STOCK,
                                              price=item.get("price"),
                                              detail=f"ikke lenger oppført hos {agg.name}"),
                            silent=bool(item.get("covered")))
        return True

    # ------------------------------------------------------------------ status
    def refresh_coverage(self) -> None:
        """Oppdaterer hvilke Prisjakt-rader som dekkes av direkte overvåking akkurat nå."""
        for item in self.state.items.values():
            if item.get("kind") == "offer":
                item["covered"] = self._store_covers(item["store"], str(item.get("sku") or ""))

    def summary(self, title: str | None = None) -> notify.Message:
        self.refresh_coverage()
        return notify.summary_message(list(self.state.items.values()), self.stores_down(),
                                      self.cfg.product_name, title)

    async def handle_command(self, command: str) -> notify.Message | None:
        if command in ("/status", "/start"):
            return self.summary()
        if command == "/ping":
            uptime = timedelta(seconds=int(time.monotonic() - self.started))
            active = sum(1 for t in self.targets if not t.disabled)
            return notify.Message(title="🏓 Pong", body=f"Oppe i {uptime}. Overvåker {active} "
                                  f"sider.", quiet=True)
        if command in ("/hjelp", "/help"):
            return notify.Message(
                title="Kommandoer",
                body="/status – status for alle butikker\n/ping – sjekk at vakten lever\n"
                     "/hjelp – denne oversikten", quiet=True)
        return None

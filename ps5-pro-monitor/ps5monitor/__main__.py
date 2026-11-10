"""Kommandolinje: python -m ps5monitor [run|once|check|status|test-notify]."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import __version__, notify
from .config import Config, load_config
from .extract import collect_signals, reconcile
from .fetcher import Fetcher, host_of, proxy_label
from .models import Availability, format_price
from .monitor import Monitor
from .state import State

log = logging.getLogger("ps5monitor")


def _setup_logging(base: Path, verbose: bool, to_file: bool) -> None:
    for stream in (sys.stdout, sys.stderr):
        try:  # Windows-konsollen er ikke alltid UTF-8
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if to_file:
        try:
            handlers.append(RotatingFileHandler(base / "monitor.log", maxBytes=1_000_000,
                                                backupCount=3, encoding="utf-8"))
        except OSError:
            pass
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    # httpx logger hele URL-en, og den inneholder Telegram-token/webhook-hemmeligheter.
    for name in ("httpx", "httpcore", "h2", "hpack"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _make_fetcher(cfg: Config) -> Fetcher:
    s = cfg.settings
    return Fetcher(user_agent=s.user_agent, timeout=s.timeout_seconds,
                   host_min_delay=s.host_min_delay_seconds, respect_robots=s.respect_robots,
                   proxies=cfg.proxies,
                   include_direct=True if s.proxy_include_direct else None,
                   warn=log.warning)


def _table(items: list[dict], stores_down: dict[str, str]) -> str:
    order = {a.value: i for i, a in enumerate(Availability)}
    rows = sorted((i for i in items if not i.get("alias_of")),
                  key=lambda i: (order.get(i.get("availability", "unknown"), 9),
                                 i.get("price") or 9e9, i["store"]))
    lines = []
    for item in rows:
        av = Availability(item.get("availability", "unknown"))
        store = item["store"] + (f" (via {item['via']})" if item.get("via") else "")
        note = item.get("sources_summary") or ""
        if item.get("covered"):
            note = "dekkes av direkte overvåking"
        if item.get("error"):
            note = f"FEIL: {item['error']}"
        lines.append(f"{av.emoji} {av.label:<18} {format_price(item.get('price')):>12}  "
                     f"{store:<26.26} {(item.get('name') or '')[:46]:<46}  {note}")
    if not lines:
        lines.append("(ingen data ennå)")
    for name, reason in sorted(stores_down.items()):
        lines.append(f"⚠️  {name}: {reason}")
    return "\n".join(lines)


async def _cmd_run(cfg: Config) -> int:
    state = State(cfg.state_path, cfg.history_path)
    fetcher, notifier = _make_fetcher(cfg), notify.Notifier(cfg)
    monitor = Monitor(cfg, state, fetcher, notifier)
    channels = ", ".join(c.name for c in notifier.channels) or "ingen (kun logg)"
    extras = []
    if cfg.proxies:
        extras.append(f"{len(cfg.proxies)} proxyer")
    if cfg.settings.burst_enabled:
        extras.append("turbo på")
    tail = (" – " + ", ".join(extras)) if extras else ""
    log.info("PS5 Pro-vakten %s – %d sider hos %d nettsteder. Varsling: %s%s", __version__,
             len(monitor.targets), len({t.host for t in monitor.targets}), channels, tail)
    if not notifier.enabled:
        log.warning("Ingen varslingskanal er satt opp – endringer vises bare her i loggen.")
    try:
        await monitor.run()
    finally:
        await notifier.drain()
        await fetcher.close()
        await notifier.close()
    return 0


async def _cmd_once(cfg: Config, send: bool) -> int:
    state = State(cfg.state_path, cfg.history_path if send else None)
    fetcher, notifier = _make_fetcher(cfg), notify.Notifier(cfg)
    if not send:  # tørrkjøring: verken lagre status eller sende varsler
        state.save = lambda force=False: None  # type: ignore[method-assign]
        notifier.channels.clear()
    monitor = Monitor(cfg, state, fetcher, notifier)
    log.info("Sjekker %d sider én gang …", len(monitor.targets))
    try:
        await monitor.run_once()
        if send:
            state.first_run = False
            state.save(force=True)
            await notifier.drain()
    finally:
        await fetcher.close()
        await notifier.close()
    monitor.refresh_coverage()
    print()
    print(_table(list(state.items.values()), monitor.stores_down()))
    return 0


async def _cmd_check(cfg: Config, url: str, store_id: str | None) -> int:
    host = host_of(url).removeprefix("www.")
    store = next((s for s in cfg.stores if s.id == store_id), None) if store_id else next(
        (s for s in cfg.stores
         if any(host_of(u).removeprefix("www.") == host for u in s.products + s.listings)), None)
    fetcher = _make_fetcher(cfg)
    try:
        result = await fetcher.get(url)
    finally:
        await fetcher.close()
    print(f"URL:     {url}")
    if result.redirected:
        print(f"Endte på: {result.final_url}")
    print(f"Svar:    {'OK' if result.ok else result.reason()} ({len(result.text)} tegn)")
    print(f"Butikk:  {store.name if store else 'ukjent (kun standardkilder brukes)'}")
    if not result.ok:
        return 1
    sku = store.sku_from_url(url) if store else None
    signals = collect_signals(result.text, extractor=store.extractor if store else None,
                              markers=store.markers if store else None, sku=sku)
    obs = reconcile(signals)
    print("\nKilder i kildekoden:")
    for sig in signals:
        print(f"  {sig.source:<10} {sig.brief()}")
    if not signals:
        print("  (ingen – siden laster trolig pris/lager med JavaScript)")
    print(f"\nResultat: {obs.availability.emoji} {obs.availability.label}, "
          f"{format_price(obs.price)}")
    print(f"Navn:     {obs.name or '?'}   Varenr: {obs.sku or sku or '?'}")
    print(f"Enighet:  {obs.sources_summary()}"
          + ("   ⚠️ kildene er uenige" if obs.conflict else ""))
    return 0


def _cmd_status(cfg: Config) -> int:
    state = State(cfg.state_path)
    down = {i.get("name", "?"): next(iter(i["failing"].values()))
            for i in state.stores.values() if i.get("failing")}
    if cfg.proxies:
        print(f"Proxyer konfigurert: {len(cfg.proxies)}  (kjør «proxies» for å teste dem)\n")
    print(_table(list(state.items.values()), down))
    return 0


async def _cmd_proxies(cfg: Config) -> int:
    """Tester hver proxy ved å hente egen utgående IP gjennom den."""
    import httpx
    if not cfg.proxies:
        print("Ingen proxyer konfigurert. Legg dem i proxies.txt (én per linje) eller i "
              "[monitor] proxies i config.toml.")
        return 1
    print(f"Tester {len(cfg.proxies)} proxy(er) mot https://api.ipify.org …\n")
    ok = 0
    for proxy in cfg.proxies:
        label = proxy_label(proxy)
        try:
            async with httpx.AsyncClient(proxy=proxy, timeout=15,
                                         headers={"User-Agent": cfg.settings.user_agent}) as c:
                resp = await c.get("https://api.ipify.org")
            resp.raise_for_status()
            print(f"  ✅ {label:<28} utgående IP: {resp.text.strip()}")
            ok += 1
        except Exception as exc:
            print(f"  ❌ {label:<28} {type(exc).__name__}: {str(exc)[:80]}")
    print(f"\n{ok} av {len(cfg.proxies)} proxyer virker.")
    return 0 if ok else 1


async def _cmd_test_notify(cfg: Config) -> int:
    notifier = notify.Notifier(cfg)
    if not notifier.enabled:
        print("Ingen varslingskanal er satt opp. Fyll inn [discord] webhook_url og/eller "
              "[telegram] bot_token + chat_id i config.toml.")
        await notifier.close()
        return 1
    msg = notify.Message(
        title="✅ Testvarsel fra PS5 Pro-vakten",
        body=f"Varslingen virker. Slik ser et varsel om {cfg.product_name} ut.",
        fields=[("Pris", "9 990 kr"), ("Status", "Utsolgt → På lager")],
        color=notify.GREEN, alert=True)
    try:
        results = await notifier.send(msg)
    finally:
        await notifier.close()
    for name, ok in results.items():
        print(f"{name}: {'sendt' if ok else 'FEILET – sjekk token/URL og loggen over'}")
    return 0 if all(results.values()) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ps5monitor", description="Overvåker norske nettbutikker for PS5 Pro.")
    parser.add_argument("--dir", help="mappe med config.toml, stores.toml og state.json")
    parser.add_argument("--config", help="sti til config.toml")
    parser.add_argument("-v", "--verbose", action="store_true", help="mer detaljert logg")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="kjør kontinuerlig (standard)")
    once = sub.add_parser("once", help="sjekk alt én gang og vis en tabell")
    once.add_argument("--notify", action="store_true",
                      help="lagre status og send varsler (for kjøring fra Oppgaveplanlegger/cron)")
    check = sub.add_parser("check", help="vis hva som leses ut av én URL")
    check.add_argument("url")
    check.add_argument("--store", help="butikk-id fra stores.toml")
    sub.add_parser("status", help="vis sist lagrede status")
    sub.add_parser("test-notify", help="send et testvarsel til Discord/Telegram")
    sub.add_parser("proxies", help="test at proxyene i proxies.txt virker")
    args = parser.parse_args(argv)
    command = args.command or "run"

    try:
        cfg = load_config(args.dir, args.config)
    except Exception as exc:  # tomllib-feil o.l. – vis en lesbar melding
        print(f"Klarte ikke å lese konfigurasjonen: {exc}", file=sys.stderr)
        return 2
    _setup_logging(cfg.base_dir, args.verbose, to_file=command == "run")
    for warning in cfg.warnings:
        log.warning(warning)

    try:
        if command == "run":
            return asyncio.run(_cmd_run(cfg))
        if command == "once":
            return asyncio.run(_cmd_once(cfg, args.notify))
        if command == "check":
            return asyncio.run(_cmd_check(cfg, args.url, args.store))
        if command == "status":
            return _cmd_status(cfg)
        if command == "proxies":
            return asyncio.run(_cmd_proxies(cfg))
        return asyncio.run(_cmd_test_notify(cfg))
    except KeyboardInterrupt:
        print("\nStoppet.")
        return 0


if __name__ == "__main__":
    sys.exit(main())

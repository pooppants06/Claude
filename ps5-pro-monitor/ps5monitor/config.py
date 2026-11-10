"""Laster config.toml (innstillinger og varsling) og stores.toml (butikker og produktsider)."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_MATCH = r"(?:playstation\W{0,3}5|\bps\W?5)\W{0,3}pro\b"
DEFAULT_EXCLUDE = (
    r"\b(?:for|til|fits)\s+(?:sony\s+)?(?:ps\W?5|playstation)|deksel|deksler|cover|faceplate|"
    r"stativ|\bstand\b|diskstasjon|dis[ck] drive|lader\b|ladestasjon|charg(?:er|ing)|kabel|"
    r"cable|veske|\bbag\b|\bskin\b|vifte|ventilator|cooling|\bfan\b|mount|veggfeste|headset|"
    r"\bdock|kontroller|controller|håndkonsoll|protector|klistremerke|sticker|"
    r"\bdemo\b|\bbrukt\b|refurb|b-vare"
)
DEFAULT_USER_AGENT = "ps5pro-vakten/1.0 (personlig lager- og prisvarsler)"
_CONSOLE_WORDS = re.compile(r"konsoll|konsole|console|\b[12] ?tb\b|digital edition", re.I)


@dataclass
class Store:
    id: str
    name: str
    products: list[str] = field(default_factory=list)
    listings: list[str] = field(default_factory=list)
    extractor: str | None = None
    markers: dict = field(default_factory=dict)
    sku_regex: str | None = None
    aliases: list[str] = field(default_factory=list)
    interval: float | None = None
    link_regex: str | None = None
    burst: bool = True  # la turbo-modus (tett sjekk ved endring) gjelde denne butikken

    def sku_from_url(self, url: str) -> str | None:
        if not self.sku_regex:
            return None
        m = re.search(self.sku_regex, urlsplit(url).path)
        return m.group(1) if m else None

    def matches_shop(self, shop_name: str) -> bool:
        wanted = _norm(shop_name)
        return wanted in {_norm(self.name), _norm(self.id), *(_norm(a) for a in self.aliases)}


@dataclass
class Aggregator:
    id: str
    name: str
    type: str = "prisjakt"
    products: list[str] = field(default_factory=list)
    listings: list[str] = field(default_factory=list)
    interval: float | None = None
    link_regex: str | None = None


@dataclass
class Settings:
    interval_seconds: float = 90
    listing_interval_seconds: float = 900
    aggregator_interval_seconds: float = 300
    jitter: float = 0.2
    confirmations: int = 2
    confirm_delay_seconds: float = 20
    host_min_delay_seconds: float = 4
    timeout_seconds: float = 25
    fail_threshold: int = 5
    max_backoff_seconds: float = 1800
    user_agent: str = DEFAULT_USER_AGENT
    respect_robots: bool = True
    notify_price_changes: bool = True
    min_price_change: float = 1
    notify_sold_out: bool = True
    notify_new_listings: bool = True
    notify_store_health: bool = True
    startup_summary: bool = True
    daily_summary: str = "08:00"
    heartbeat_url: str = ""
    heartbeat_interval_seconds: float = 300
    auto_discover: bool = True
    # Proxy-liste: hvilken fil proxyene leses fra, og om egen IP skal brukes i tillegg.
    proxies_file: str = "proxies.txt"
    proxy_include_direct: bool = False
    # Turbo: når kildekoden til en side endrer seg, sjekkes den tett en periode.
    burst_enabled: bool = True
    burst_interval_seconds: float = 20
    burst_duration_seconds: float = 3600
    burst_notify: bool = False


@dataclass
class Discord:
    webhook_url: str = ""
    mention: str = ""
    username: str = "PS5 Pro-vakten"

    @property
    def enabled(self) -> bool:
        return self.webhook_url.startswith("http")


@dataclass
class Telegram:
    bot_token: str = ""
    chat_id: str = ""
    commands: bool = True

    @property
    def enabled(self) -> bool:
        return bool(self.bot_token and self.chat_id)


@dataclass
class Config:
    base_dir: Path
    settings: Settings = field(default_factory=Settings)
    discord: Discord = field(default_factory=Discord)
    telegram: Telegram = field(default_factory=Telegram)
    product_name: str = "PlayStation 5 Pro"
    match: str = DEFAULT_MATCH
    exclude: str = DEFAULT_EXCLUDE
    stores: list[Store] = field(default_factory=list)
    aggregators: list[Aggregator] = field(default_factory=list)
    proxies: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        self._match = re.compile(self.match, re.I)
        self._exclude = re.compile(self.exclude, re.I) if self.exclude else None

    @property
    def state_path(self) -> Path:
        return self.base_dir / "state.json"

    @property
    def history_path(self) -> Path:
        return self.base_dir / "history.jsonl"

    def is_wanted(self, text: str) -> bool:
        """Sann hvis teksten (produktnavn eller URL-slug) beskriver selve konsollen.

        Brukes når nye produktsider oppdages automatisk. Tilbehør («... til PS5 Pro»,
        deksler, kontrollere) avvises: treffet må enten stå først i navnet eller navnet
        må inneholde et konsoll-ord.
        """
        text = re.sub(r"[-_/+]+|®|™", lambda m: " + " if "+" in m.group(0) else " ", text.lower())
        text = " ".join(text.split())
        if not self._match.search(text):
            return False
        # I pakker («PS5 Pro + DualSense Edge») skal bare selve konsoll-delen vurderes.
        main = next((part for part in text.split(" + ") if self._match.search(part)), text)
        if self._exclude and self._exclude.search(main):
            return False
        lead = re.sub(r"^(?:sony|playstation(?= playstation)|\s)+", "", main)
        hit = self._match.search(lead)
        return bool(hit and (hit.start() <= 3 or _CONSOLE_WORDS.search(main)))

    def mentions(self, text: str) -> bool:
        """Sann hvis teksten i det hele tatt nevner produktet (også tilbehør til det)."""
        return bool(self._match.search(" ".join(re.sub(r"[-_/+]+|®|™", " ", text.lower()).split())))

    def store_for_shop(self, shop_name: str) -> Store | None:
        return next((s for s in self.stores if s.matches_shop(shop_name)), None)


def _norm(text: str) -> str:
    text = text.lower().replace("ø", "o").replace("å", "a").replace("æ", "ae")
    text = re.sub(r"\.(no|com|se|dk)\b", "", text)
    return re.sub(r"[^a-z0-9]", "", text)


def _fill(obj, data: dict, section: str, warnings: list[str]):
    for key, value in data.items():
        if not hasattr(obj, key):
            warnings.append(f"Ukjent innstilling [{section}] {key}")
            continue
        current = getattr(obj, key)
        if isinstance(current, bool):
            value = bool(value)
        elif isinstance(current, int) and not isinstance(value, bool):
            value = int(value)
        elif isinstance(current, float):
            value = float(value)
        elif isinstance(current, str):
            value = str(value).strip()
        setattr(obj, key, value)


def _read_toml(path: Path) -> dict:
    with open(path, "rb") as fh:
        return tomllib.load(fh)


_PROXY_SCHEMES = ("http", "https", "socks5", "socks5h", "socks4")


def _load_proxies(base: Path, filename: str, from_config: list, warnings: list[str]) -> list[str]:
    """Slår sammen proxyer fra config, miljøvariabel (PS5_PROXIES) og en fil (én per linje)."""
    raw = [str(p) for p in from_config]
    env = os.environ.get("PS5_PROXIES", "").strip()
    if env:
        raw += re.split(r"[\s,]+", env)
    path = (base / filename) if filename else None
    if path and path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                raw.append(line)
    out: list[str] = []
    for proxy in raw:
        proxy = proxy.strip()
        if not proxy:
            continue
        if "://" not in proxy:  # «host:port» antas å være en http-proxy
            proxy = "http://" + proxy
        parts = urlsplit(proxy)
        if parts.scheme not in _PROXY_SCHEMES or not parts.hostname:
            warnings.append(f"Hopper over ugyldig proxy: {proxy!r}")
            continue
        if proxy not in out:
            out.append(proxy)
    return out


def _load_stores(cfg: Config, data: dict) -> None:
    by_id = {s.id: s for s in cfg.stores}
    for raw in data.get("store", []):
        sid = str(raw["id"])
        store = by_id.get(sid)
        if store is None:
            store = Store(id=sid, name=str(raw.get("name", sid)))
            by_id[sid] = store
            cfg.stores.append(store)
        for key in ("name", "extractor", "sku_regex", "interval", "link_regex", "burst"):
            if key in raw:
                setattr(store, key, raw[key])
        for key in ("products", "listings", "aliases"):
            for value in raw.get(key, []):
                if value not in getattr(store, key):
                    getattr(store, key).append(value)
        for key, patterns in raw.get("markers", {}).items():
            store.markers.setdefault(key, [])
            store.markers[key] += [p for p in patterns if p not in store.markers[key]]

    agg_by_id = {a.id: a for a in cfg.aggregators}
    for raw in data.get("aggregator", []):
        aid = str(raw["id"])
        agg = agg_by_id.get(aid)
        if agg is None:
            agg = Aggregator(id=aid, name=str(raw.get("name", aid)))
            agg_by_id[aid] = agg
            cfg.aggregators.append(agg)
        for key in ("name", "type", "interval", "link_regex"):
            if key in raw:
                setattr(agg, key, raw[key])
        for key in ("products", "listings"):
            for value in raw.get(key, []):
                if value not in getattr(agg, key):
                    getattr(agg, key).append(value)


def load_config(base_dir: str | os.PathLike | None = None,
                config_path: str | os.PathLike | None = None) -> Config:
    base = Path(base_dir) if base_dir else Path(__file__).resolve().parent.parent
    cfg_file = Path(config_path) if config_path else base / "config.toml"
    data = _read_toml(cfg_file) if cfg_file.exists() else {}

    product = data.get("product", {})
    cfg = Config(
        base_dir=base,
        product_name=product.get("name", "PlayStation 5 Pro"),
        match=product.get("match", DEFAULT_MATCH),
        exclude=product.get("exclude", DEFAULT_EXCLUDE),
    )
    if not cfg_file.exists():
        cfg.warnings.append(
            f"Fant ikke {cfg_file.name} – bruker standardverdier. Kopier config.example.toml "
            "til config.toml og legg inn Discord/Telegram for å få varsler.")
    monitor_data = dict(data.get("monitor", {}))
    proxy_list = monitor_data.pop("proxies", [])  # liste, ikke en skalar innstilling
    _fill(cfg.settings, monitor_data, "monitor", cfg.warnings)
    _fill(cfg.discord, data.get("discord", {}), "discord", cfg.warnings)
    _fill(cfg.telegram, data.get("telegram", {}), "telegram", cfg.warnings)
    cfg.proxies = _load_proxies(base, cfg.settings.proxies_file, proxy_list, cfg.warnings)

    # Miljøvariabler overstyrer, så hemmeligheter kan holdes utenfor filer.
    cfg.discord.webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", cfg.discord.webhook_url)
    cfg.telegram.bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", cfg.telegram.bot_token)
    cfg.telegram.chat_id = str(os.environ.get("TELEGRAM_CHAT_ID", cfg.telegram.chat_id))

    for name in ("stores.toml", "stores.local.toml"):
        path = base / name
        if path.exists():
            _load_stores(cfg, _read_toml(path))
    if not cfg.stores and not cfg.aggregators:
        cfg.warnings.append("Ingen butikker er definert i stores.toml.")

    for store in cfg.stores:
        for patterns in store.markers.values():
            for pattern in patterns:
                try:
                    re.compile(pattern)
                except re.error as exc:
                    cfg.warnings.append(f"Ugyldig markør for {store.name}: {pattern!r} ({exc})")
    s = cfg.settings
    s.confirmations = max(1, s.confirmations)
    s.interval_seconds = max(15.0, s.interval_seconds)
    s.host_min_delay_seconds = max(1.0, s.host_min_delay_seconds)
    s.burst_interval_seconds = max(5.0, s.burst_interval_seconds)
    s.burst_duration_seconds = min(max(60.0, s.burst_duration_seconds), 86400.0)
    return cfg

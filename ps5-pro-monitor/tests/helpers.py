"""Felles testhjelpere: en liten «falsk nettbutikk» og HTML-generatorer."""

from __future__ import annotations

import json
import random
import tempfile
from collections import Counter
from pathlib import Path

import httpx

from ps5monitor import notify
from ps5monitor.config import Aggregator, Config, Store
from ps5monitor.fetcher import Fetcher
from ps5monitor.monitor import Monitor
from ps5monitor.state import State


def product_html(name="PlayStation 5 Pro 2TB", price=9990, availability="OutOfStock",
                 sku="1001", extra="") -> str:
    ld = {"@context": "https://schema.org", "@type": "Product", "name": name, "sku": sku,
          "offers": {"@type": "Offer", "price": f"{price:.2f}", "priceCurrency": "NOK",
                     "availability": f"https://schema.org/{availability}"}}
    meta_av = "in stock" if availability == "InStock" else "out of stock"
    return f"""<!doctype html><html><head><title>{name} | Testbutikken</title>
<script type="application/ld+json">{json.dumps(ld)}</script>
<meta property="product:price:amount" content="{price}">
<meta property="product:availability" content="{meta_av}">
</head><body><h1>{name}</h1>{extra}</body></html>"""


def flight(payload: str) -> str:
    """Pakker tekst slik Next.js gjør i self.__next_f.push([1,"..."])."""
    return f"<script>self.__next_f.push([1,{json.dumps(payload)}])</script>"


def prisjakt_html(offers: list[dict], title="Sony PlayStation 5 Pro (PS5) 2TB") -> str:
    rows = []
    for i, o in enumerate(offers):
        rows.append({
            "index": i, "shopId": o.get("shop_id", 100 + i),
            "shopOfferId": o.get("offer_id", f"offer{i}"),
            "price": {"amount": o["price"], "currency": "NOK"},
            "name": o.get("name", "PlayStation 5 Pro 2TB"),
            "condition": o.get("condition", "New"),
            "stockStatus": o.get("stock", "OutOfStock"),
            "availabilityDate": "$undefined",
            "shop": {"name": o["shop"], "membershipProgram": "$undefined"},
        })
    payload = '5e:["$","div",null,{"offerRows":' + json.dumps(rows) + ',"other":1}]\n'
    return (f"<html><head><title>{title} - Prisjakt</title></head><body>"
            f"{flight(payload)}</body></html>")


class FakeWeb:
    """Svarer på HTTP-forespørsler fra en ordbok, og fanger opp varsler til Discord/Telegram."""

    def __init__(self):
        self.pages: dict[str, tuple[int, str]] = {}
        self.redirects: dict[str, str] = {}
        self.hits: Counter = Counter()
        self.discord: list[dict] = []
        self.telegram: list[dict] = []
        self.user_agents: set[str] = set()

    def set(self, url: str, body: str, status: int = 200) -> None:
        self.pages[url] = (status, body)

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.hits[url] += 1
        if "discord.test" in url:
            self.discord.append(json.loads(request.content))
            return httpx.Response(204)
        if "api.telegram.org" in url:
            self.telegram.append(json.loads(request.content))
            return httpx.Response(200, json={"ok": True, "result": []})
        self.user_agents.add(request.headers.get("user-agent", ""))
        if url in self.redirects:
            return httpx.Response(301, headers={"location": self.redirects[url]})
        if url in self.pages:
            status, body = self.pages[url]
            return httpx.Response(status, text=body,
                                  headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404, text="not found")

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def make_config(tmp: Path | None = None, **settings) -> Config:
    base = tmp or Path(tempfile.mkdtemp(prefix="ps5test-"))
    cfg = Config(base_dir=base)
    cfg.settings.host_min_delay_seconds = 0
    cfg.settings.confirm_delay_seconds = 0
    cfg.settings.jitter = 0
    cfg.settings.respect_robots = False
    for key, value in settings.items():
        assert hasattr(cfg.settings, key), key
        setattr(cfg.settings, key, value)
    return cfg


def make_monitor(cfg: Config, web: FakeWeb, *, discord=True, telegram=False):
    if discord:
        cfg.discord.webhook_url = "https://discord.test/api/webhooks/1/abc"
    if telegram:
        cfg.telegram.bot_token, cfg.telegram.chat_id = "123:ABC", "42"
    s = cfg.settings
    fetcher = Fetcher(user_agent=s.user_agent, timeout=5, host_min_delay=s.host_min_delay_seconds,
                      respect_robots=s.respect_robots, transport=web.transport)
    notifier = notify.Notifier(cfg, transport=web.transport)
    state = State(cfg.state_path, cfg.history_path)
    monitor = Monitor(cfg, state, fetcher, notifier, rng=random.Random(1))
    return monitor, notifier, state


def store(id="butikk", name="Testbutikken", products=(), **kw) -> Store:
    return Store(id=id, name=name, products=list(products), **kw)


def aggregator(products=(), **kw) -> Aggregator:
    return Aggregator(id="prisjakt", name="Prisjakt", products=list(products), **kw)

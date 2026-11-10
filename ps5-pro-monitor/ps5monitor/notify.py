"""Varsling til Discord (webhook) og Telegram (bot), pluss formatering av meldingene."""

from __future__ import annotations

import asyncio
import html
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from .config import Config
from .models import Availability, format_price

log = logging.getLogger("ps5monitor.notify")

GREEN, RED, YELLOW, BLUE, GREY = 0x2ECC71, 0xE74C3C, 0xF1C40F, 0x3498DB, 0x95A5A6


@dataclass
class Message:
    title: str
    body: str = ""  # kan inneholde [tekst](url)-lenker
    url: str | None = None
    fields: list[tuple[str, str]] = field(default_factory=list)
    color: int = BLUE
    alert: bool = False  # sann = viktig (på lager) – kan @-nevne og gi lyd
    quiet: bool = False  # sann = lydløs (oppsummeringer)

    def plain(self) -> str:
        lines = [self.title]
        if self.body:
            lines.append(re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1", self.body))
        lines += [f"{k}: {v}" for k, v in self.fields]
        if self.url:
            lines.append(self.url)
        return "\n".join(lines)


# --------------------------------------------------------------------------- formatering
def _status_text(av: str, detail: str | None = None) -> str:
    label = Availability(av).label
    return f"{label} ({detail})" if detail else label


def _price_delta(old: float, new: float) -> str:
    diff = new - old
    pct = diff / old * 100 if old else 0
    sign = "−" if diff < 0 else "+"
    return f"{sign}{format_price(abs(diff))}, {sign}{abs(pct):.1f} %".replace(".", ",")


def change_message(item: dict, kind: str, old_av: str, old_price: float | None) -> Message:
    store, name = item["store"], item.get("name") or "PS5 Pro"
    new_av, price = item["availability"], item.get("price")
    via = f" (via {item['via']})" if item.get("via") else ""
    titles = {
        "restock": (f"🟢 {Availability(new_av).label.upper()} hos {store}{via}", GREEN),
        "sold_out": (f"🔴 {Availability(new_av).label} hos {store}{via}", RED),
        "status": (f"ℹ️ Ny status hos {store}{via}: {Availability(new_av).label}", BLUE),
        "price_drop": (f"💰 Prisfall hos {store}{via}", GREEN),
        "price_up": (f"📈 Prisøkning hos {store}{via}", YELLOW),
    }
    title, color = titles[kind]
    fields = []
    if old_price is not None and price is not None and abs(price - old_price) >= 0.5:
        fields.append(("Pris", f"{format_price(old_price)} → {format_price(price)} "
                               f"({_price_delta(old_price, price)})"))
    else:
        fields.append(("Pris", format_price(price)))
    if old_av != new_av:
        fields.append(("Status", f"{Availability(old_av).label} → "
                                 f"{_status_text(new_av, item.get('detail'))}"))
    else:
        fields.append(("Status", _status_text(new_av, item.get("detail"))))
    if item.get("sources_summary"):
        fields.append(("Kilder", item["sources_summary"]))
    if item.get("conflict"):
        fields.append(("Obs", "⚠️ Kildene på siden er uenige – sjekk selv før du stoler på det."))
    return Message(title=title, body=name, url=item.get("url"), fields=fields, color=color,
                   alert=(kind == "restock"))


def new_listing_message(item: dict) -> Message:
    av = Availability(item["availability"])
    what = "Nytt tilbud" if item.get("via") else "Ny produktside"
    via = f" (via {item['via']})" if item.get("via") else ""
    return Message(
        title=f"🆕 {what} hos {item['store']}{via}",
        body=item.get("name") or "PS5 Pro",
        url=item.get("url"),
        fields=[("Pris", format_price(item.get("price"))),
                ("Status", f"{av.emoji} {_status_text(av.value, item.get('detail'))}")],
        color=GREEN if av.buyable else BLUE,
        alert=av.buyable,
    )


def burst_message(store: str, minutes: int) -> Message:
    return Message(
        title=f"⚡ Turbo på {store}",
        body=f"Kildekoden endret seg – sjekker {store} tett de neste ~{minutes} minuttene.",
        color=YELLOW, quiet=True)


def store_health_message(store: str, down: bool, reason: str = "") -> Message:
    if down:
        return Message(
            title=f"⚠️ Får ikke sjekket {store}",
            body=f"Årsak: {reason}. Jeg prøver igjen sjeldnere og sier fra når det virker.",
            color=YELLOW)
    return Message(title=f"✅ {store} svarer igjen", color=GREEN, quiet=True)


def _summary_line(item: dict) -> str:
    av = Availability(item.get("availability", "unknown"))
    store = item["store"] + (f" (via {item['via']})" if item.get("via") else "")
    link = f"[{store}]({item['url']})" if item.get("url") else store
    line = f"{av.emoji} {link} — {av.label}, {format_price(item.get('price'))}"
    name = item.get("name")
    if name and av.buyable:  # navnet tas bare med der det er noe å kjøpe – holder listen kort
        line += f" — {name[:50]}"
    if item.get("error"):
        line += " ⚠️"
    return line


def summary_message(items: list[dict], stores_down: dict[str, str], product: str,
                    title: str | None = None) -> Message:
    order = {a.value: i for i, a in enumerate(Availability)}
    visible = [i for i in items if not i.get("alias_of") and not i.get("covered")]
    visible.sort(key=lambda i: (order.get(i.get("availability", "unknown"), 9),
                                i.get("price") or 9e9, i["store"]))
    buyable = [i for i in visible if Availability(i.get("availability", "unknown")).buyable]
    lines = list(dict.fromkeys(_summary_line(i) for i in visible))
    if stores_down:
        lines.append("")
        lines += [f"⚠️ {name}: {reason}" for name, reason in sorted(stores_down.items())]
    shops = len({i["store"] for i in visible})
    head = (f"{len(buyable)} av {len(visible)} oppføringer kan kjøpes nå "
            f"({shops} butikker overvåkes).")
    if buyable:
        cheapest = min((i for i in buyable if i.get("price")), key=lambda i: i["price"],
                       default=None)
        if cheapest:
            head += f" Billigst: {cheapest['store']} {format_price(cheapest['price'])}."
    return Message(title=title or f"📋 Status {product}", body="\n".join([head, "", *lines]),
                   color=GREEN if buyable else GREY, quiet=True)


# --------------------------------------------------------------------------- kanaler
def _chunks(text: str, limit: int) -> list[str]:
    parts, current = [], ""
    for line in text.split("\n"):
        line = line[:limit]
        if len(current) + len(line) + 1 > limit:
            parts.append(current)
            current = line
        else:
            current = f"{current}\n{line}" if current else line
    if current:
        parts.append(current)
    return parts or [""]


class DiscordChannel:
    name = "Discord"

    def __init__(self, cfg: Config, client: httpx.AsyncClient):
        self.cfg, self.client = cfg.discord, client

    def payloads(self, msg: Message) -> list[dict]:
        out = []
        chunks = _chunks(msg.body, 3800)
        for index, chunk in enumerate(chunks):
            embed: dict = {"description": chunk, "color": msg.color}
            if index == 0:
                embed["title"] = msg.title[:256]
                if msg.url:
                    embed["url"] = msg.url
            if index == len(chunks) - 1:
                embed["fields"] = [{"name": k[:256], "value": v[:1024], "inline": False}
                                   for k, v in msg.fields[:25]]
                embed["timestamp"] = datetime.now(timezone.utc).isoformat()
            payload: dict = {"username": self.cfg.username, "embeds": [embed],
                             "allowed_mentions": {"parse": []}}
            if index == 0 and msg.alert and self.cfg.mention:
                payload["content"] = self.cfg.mention
                payload["allowed_mentions"] = {"parse": ["everyone", "users", "roles"]}
            if msg.quiet:
                payload["flags"] = 4096  # ikke push-varsel
            out.append(payload)
        return out

    async def send(self, msg: Message) -> bool:
        for payload in self.payloads(msg):
            for _attempt in range(4):
                resp = await self.client.post(self.cfg.webhook_url, json=payload)
                if resp.status_code == 429:
                    try:
                        delay = float(resp.json().get("retry_after", 2))
                    except (ValueError, AttributeError):
                        delay = 2.0
                    await asyncio.sleep(min(delay + 0.2, 30))
                    continue
                if resp.status_code >= 400:
                    log.warning("Discord svarte %s: %s", resp.status_code, resp.text[:200])
                    return False
                break
            else:
                return False
        return True


class TelegramChannel:
    name = "Telegram"

    def __init__(self, cfg: Config, client: httpx.AsyncClient):
        self.cfg, self.client = cfg.telegram, client
        self.api = f"https://api.telegram.org/bot{self.cfg.bot_token}"
        self._offset = 0

    @staticmethod
    def render(msg: Message) -> str:
        def esc(text: str) -> str:
            return html.escape(text, quote=False)

        def links(text: str) -> str:
            return re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)",
                          lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', esc(text))

        parts = [f"<b>{esc(msg.title)}</b>"]
        if msg.body:
            parts.append(links(msg.body))
        parts += [f"<b>{esc(k)}:</b> {esc(v)}" for k, v in msg.fields]
        if msg.url:
            parts.append(f'<a href="{html.escape(msg.url)}">Åpne siden</a>')
        return "\n".join(parts)

    async def _call(self, method: str, payload: dict, timeout: float = 20) -> dict | None:
        for _attempt in range(3):
            resp = await self.client.post(f"{self.api}/{method}", json=payload, timeout=timeout)
            if resp.status_code == 429:
                delay = resp.json().get("parameters", {}).get("retry_after", 2)
                await asyncio.sleep(min(float(delay) + 0.2, 30))
                continue
            data = resp.json() if resp.headers.get("content-type", "").startswith(
                "application/json") else {}
            if resp.status_code >= 400 or not data.get("ok"):
                log.warning("Telegram svarte %s: %s", resp.status_code,
                            str(data.get("description") or resp.text)[:200])
                return None
            return data
        return None

    async def send(self, msg: Message, chat_id: str | None = None) -> bool:
        ok = True
        for chunk in _chunks(self.render(msg), 4000):
            result = await self._call("sendMessage", {
                "chat_id": chat_id or self.cfg.chat_id,
                "text": chunk,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
                "disable_notification": msg.quiet,
            })
            ok = ok and result is not None
        return ok

    async def poll_commands(self, handler) -> None:
        """Lytter på /status, /ping og /hjelp fra den konfigurerte chatten."""
        first = True
        while True:
            try:
                data = await self._call("getUpdates", {
                    "offset": self._offset, "timeout": 0 if first else 25,
                    "allowed_updates": ["message"]}, timeout=40)
            except (httpx.HTTPError, ValueError):
                data = None
            if data is None:
                await asyncio.sleep(15)
                continue
            updates = data.get("result")
            for update in updates if isinstance(updates, list) else []:
                if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
                    continue
                self._offset = max(self._offset, update["update_id"] + 1)
                message = update.get("message") or {}
                text = (message.get("text") or "").strip()
                chat = str((message.get("chat") or {}).get("id", ""))
                # Kommandoer som lå i kø før oppstart hoppes over; fremmede chatter ignoreres.
                if first or chat != str(self.cfg.chat_id) or not text.startswith("/"):
                    continue
                command = text.split()[0].split("@")[0].lower()
                try:
                    reply = await handler(command)
                    if reply is not None:
                        await self.send(reply)
                except Exception:
                    log.exception("Feil ved håndtering av %s", command)
            first = False
            # Long polling venter normalt hos Telegram; pausen hindrer en tett løkke hvis
            # svaret av en eller annen grunn kommer umiddelbart.
            await asyncio.sleep(0.2)


class Notifier:
    """Sender meldinger til alle aktiverte kanaler, én om gangen, uten å blokkere sjekkene."""

    def __init__(self, cfg: Config, transport: httpx.AsyncBaseTransport | None = None):
        self.cfg = cfg
        self.client = httpx.AsyncClient(timeout=20, transport=transport)
        self.channels: list = []
        if cfg.discord.enabled:
            self.channels.append(DiscordChannel(cfg, self.client))
        self.telegram: TelegramChannel | None = None
        if cfg.telegram.enabled:
            self.telegram = TelegramChannel(cfg, self.client)
            self.channels.append(self.telegram)
        self.queue: asyncio.Queue[Message] = asyncio.Queue()
        self.sent: list[Message] = []
        self.failures = 0

    @property
    def enabled(self) -> bool:
        return bool(self.channels)

    def post(self, msg: Message) -> None:
        log.info("VARSEL: %s", msg.plain().replace("\n", " | "))
        self.sent.append(msg)
        del self.sent[:-200]
        self.queue.put_nowait(msg)

    async def send(self, msg: Message) -> dict[str, bool]:
        results = {}
        for channel in self.channels:
            try:
                results[channel.name] = await channel.send(msg)
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("%s: sending feilet (%s)", channel.name, type(exc).__name__)
                results[channel.name] = False
            if not results[channel.name]:
                self.failures += 1
        return results

    async def worker(self) -> None:
        while True:
            msg = await self.queue.get()
            try:
                await self.send(msg)
            except Exception:
                log.exception("Uventet feil ved sending av varsel")
            finally:
                self.queue.task_done()
            await asyncio.sleep(0.6)  # hold oss godt under kanalenes rategrenser

    async def drain(self) -> None:
        while not self.queue.empty():
            msg = self.queue.get_nowait()
            await self.send(msg)
            self.queue.task_done()

    async def close(self) -> None:
        await self.client.aclose()

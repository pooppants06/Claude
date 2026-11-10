import asyncio
import json
import unittest

import httpx

from ps5monitor import notify
from ps5monitor.notify import DiscordChannel, Message, Notifier, TelegramChannel

from .helpers import make_config


def item(**kw):
    base = {"store": "Komplett", "name": "PlayStation 5 Pro 2TB", "availability": "in_stock",
            "price": 17990, "url": "https://www.komplett.no/product/1346176", "detail": None}
    return {**base, **kw}


class FormatTest(unittest.TestCase):
    def test_restock_message(self):
        msg = notify.change_message(
            item(detail="50+ stk", sources_summary="jsonld ✓ · markers ✓ (2/2 enige)"),
            "restock", "out_of_stock", 17990)
        self.assertEqual(msg.title, "🟢 PÅ LAGER hos Komplett")
        self.assertTrue(msg.alert)
        self.assertEqual(dict(msg.fields), {
            "Pris": "17 990 kr", "Status": "Utsolgt → På lager (50+ stk)",
            "Kilder": "jsonld ✓ · markers ✓ (2/2 enige)"})
        self.assertIn("https://www.komplett.no/product/1346176", msg.plain())

    def test_store_only_restock_says_so(self):
        msg = notify.change_message(item(availability="in_store"), "restock", "out_of_stock", None)
        self.assertEqual(msg.title, "🟢 KUN I BUTIKK hos Komplett")

    def test_price_messages(self):
        drop = notify.change_message(item(price=15990), "price_drop", "in_stock", 17990)
        self.assertIn("17 990 kr → 15 990 kr (−2 000 kr, −11,1 %)", dict(drop.fields)["Pris"])
        self.assertFalse(drop.alert)
        up = notify.change_message(item(price=19990), "price_up", "in_stock", 17990)
        self.assertIn("+2 000 kr, +11,1 %", dict(up.fields)["Pris"])

    def test_summary_sorts_buyable_first_and_hides_covered_offers(self):
        items = [
            item(store="Elkjøp", availability="out_of_stock", price=10499, url="https://e.test/1"),
            item(store="Komplett"),
            item(store="Komplett", via="Prisjakt", covered=True),
            item(store="Obs", via="Prisjakt", availability="out_of_stock", price=10990,
                 url="https://p.test/1"),
        ]
        msg = notify.summary_message(items, {"Proshop": "HTTP 403"}, "PlayStation 5 Pro")
        lines = msg.body.split("\n")
        self.assertIn("1 av 3 oppføringer kan kjøpes nå (3 butikker overvåkes)", lines[0])
        self.assertIn("Billigst: Komplett 17 990 kr", lines[0])
        self.assertTrue(lines[2].startswith("🟢 [Komplett](https://www.komplett.no/product/1346176)"))
        self.assertIn("Obs (via Prisjakt)", msg.body)
        self.assertEqual(msg.body.count("Komplett]("), 1)
        self.assertIn("⚠️ Proshop: HTTP 403", msg.body)
        self.assertTrue(msg.quiet)

    def test_empty_summary(self):
        msg = notify.summary_message([], {}, "PlayStation 5 Pro")
        self.assertIn("0 av 0", msg.body)


class DiscordTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cfg = make_config()
        self.cfg.discord.webhook_url = "https://discord.test/api/webhooks/1/abc"
        self.requests: list[dict] = []
        self.responses: list[httpx.Response] = []

    def handler(self, request):
        self.requests.append(json.loads(request.content))
        return self.responses.pop(0) if self.responses else httpx.Response(204)

    def channel(self):
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self.handler))
        self.addAsyncCleanup(self.client.aclose)
        return DiscordChannel(self.cfg, self.client)

    def test_mention_only_on_alerts(self):
        self.cfg.discord.mention = "@everyone"
        ch = DiscordChannel(self.cfg, None)
        alert = ch.payloads(Message("På lager", alert=True))[0]
        self.assertEqual(alert["content"], "@everyone")
        self.assertIn("everyone", alert["allowed_mentions"]["parse"])
        info = ch.payloads(Message("Prisfall"))[0]
        self.assertNotIn("content", info)
        self.assertEqual(info["allowed_mentions"], {"parse": []})

    def test_long_bodies_are_split_within_discord_limits(self):
        ch = DiscordChannel(self.cfg, None)
        body = "\n".join(f"linje {i} " + "x" * 90 for i in range(120))
        payloads = ch.payloads(Message("T" * 400, body=body, fields=[("Pris", "1 kr")]))
        self.assertGreater(len(payloads), 1)
        for p in payloads:
            self.assertLessEqual(len(p["embeds"][0]["description"]), 4096)
        self.assertLessEqual(len(payloads[0]["embeds"][0]["title"]), 256)
        self.assertNotIn("fields", payloads[0]["embeds"][0])
        self.assertEqual(payloads[-1]["embeds"][0]["fields"][0]["name"], "Pris")
        self.assertEqual("\n".join(p["embeds"][0]["description"] for p in payloads), body)

    async def test_retries_after_rate_limit(self):
        self.responses = [httpx.Response(429, json={"retry_after": 0.01}), httpx.Response(204)]
        self.assertTrue(await self.channel().send(Message("Hei")))
        self.assertEqual(len(self.requests), 2)

    async def test_reports_failure(self):
        self.responses = [httpx.Response(404, json={"message": "Unknown Webhook"})]
        with self.assertLogs("ps5monitor.notify", level="WARNING"):
            self.assertFalse(await self.channel().send(Message("Hei")))


class TelegramTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cfg = make_config()
        self.cfg.telegram.bot_token, self.cfg.telegram.chat_id = "123:ABC", "42"
        self.calls: list[tuple[str, dict]] = []
        self.updates: list[list[dict]] = []

    def handler(self, request):
        method = request.url.path.rsplit("/", 1)[-1]
        self.calls.append((method, json.loads(request.content)))
        if method == "getUpdates":
            return httpx.Response(200, json={"ok": True, "result":
                                             self.updates.pop(0) if self.updates else []})
        return httpx.Response(200, json={"ok": True, "result": {}})

    def channel(self):
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self.handler))
        self.addAsyncCleanup(self.client.aclose)
        return TelegramChannel(self.cfg, self.client)

    def test_render_escapes_html_and_converts_links(self):
        text = TelegramChannel.render(Message(
            "Kjell & Company <test>", body="🟢 [Kjell & Co](https://k.test/a?b=1&c=2) — 1 < 2",
            fields=[("Pris", "9 990 kr")], url="https://k.test/p?a=1&b=2"))
        self.assertIn("<b>Kjell &amp; Company &lt;test&gt;</b>", text)
        self.assertIn('<a href="https://k.test/a?b=1&amp;c=2">Kjell &amp; Co</a> — 1 &lt; 2', text)
        self.assertIn("<b>Pris:</b> 9 990 kr", text)
        self.assertIn('<a href="https://k.test/p?a=1&amp;b=2">Åpne siden</a>', text)

    async def test_send_uses_chat_and_silent_flag(self):
        ch = self.channel()
        self.assertTrue(await ch.send(Message("Status", quiet=True)))
        method, payload = self.calls[0]
        self.assertEqual(method, "sendMessage")
        self.assertEqual((payload["chat_id"], payload["parse_mode"]), ("42", "HTML"))
        self.assertTrue(payload["disable_notification"])

    async def test_commands_only_from_own_chat_and_not_from_backlog(self):
        def update(uid, chat, text):
            return {"update_id": uid, "message": {"chat": {"id": chat}, "text": text}}

        self.updates = [
            [update(1, 42, "/status")],                       # lå i kø før oppstart
            [update(2, 999, "/status"), update(3, 42, "hei"), update(4, 42, "/status@MinBot")],
        ]
        seen = []

        async def handler(command):
            seen.append(command)
            return Message("svar")

        ch = self.channel()
        task = asyncio.create_task(ch.poll_commands(handler))
        for _ in range(100):
            await asyncio.sleep(0.05)
            if sum(1 for m, _ in self.calls if m == "getUpdates") >= 3:
                break
        task.cancel()
        self.assertEqual(seen, ["/status"])
        self.assertEqual(sum(1 for m, _ in self.calls if m == "sendMessage"), 1)
        offsets = [p["offset"] for m, p in self.calls if m == "getUpdates"]
        self.assertEqual(offsets[:3], [0, 2, 5])


class NotifierTest(unittest.IsolatedAsyncioTestCase):
    async def test_fan_out_and_failure_isolation(self):
        cfg = make_config()
        cfg.discord.webhook_url = "https://discord.test/api/webhooks/1/abc"
        cfg.telegram.bot_token, cfg.telegram.chat_id = "123:ABC", "42"
        seen = []

        def handler(request):
            seen.append(request.url.host)
            if request.url.host == "discord.test":
                raise httpx.ConnectError("nede")
            return httpx.Response(200, json={"ok": True, "result": {}})

        notifier = Notifier(cfg, transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(notifier.close)
        with self.assertLogs("ps5monitor.notify", level="WARNING") as logs:
            results = await notifier.send(Message("Hei"))
        self.assertEqual(results, {"Discord": False, "Telegram": True})
        self.assertEqual(seen, ["discord.test", "api.telegram.org"])
        self.assertNotIn("abc", "".join(logs.output))  # hemmeligheter skal ikke i loggen

    async def test_no_channels(self):
        notifier = Notifier(make_config())
        self.addAsyncCleanup(notifier.close)
        self.assertFalse(notifier.enabled)
        notifier.post(Message("Bare logg"))
        await notifier.drain()
        self.assertEqual(len(notifier.sent), 1)


if __name__ == "__main__":
    unittest.main()

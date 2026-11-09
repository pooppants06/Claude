import asyncio
import json
import time
import unittest

from .helpers import (FakeWeb, aggregator, make_config, make_monitor, prisjakt_html,
                      product_html, store)

URL = "https://butikk.test/produkt/playstation-5-pro-2tb/1001"


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.web = FakeWeb()
        self.cfg = make_config()

    async def start(self, **kw):
        """Bygger overvåkeren, kjører grunnlinjen og går ut av «første kjøring»-modus."""
        self.monitor, self.notifier, self.state = make_monitor(self.cfg, self.web, **kw)
        await self.monitor.run_once()
        self.assertEqual(self.notifier.sent, [], "første kjøring skal ikke varsle")
        self.monitor.first_run = False
        return self.monitor

    async def asyncTearDown(self):
        if hasattr(self, "monitor"):
            await self.monitor.fetcher.close()
            await self.notifier.close()

    def titles(self):
        return [m.title for m in self.notifier.sent]

    def target(self, url=URL):
        return self.monitor._find_target(url)


class ChangeDetectionTest(Base):
    def setUp(self):
        super().setUp()
        self.cfg.stores.append(store(products=[URL], sku_regex=r"/(\d+)$"))
        self.web.set(URL, product_html(price=9990, availability="OutOfStock"))

    async def test_restock_is_confirmed_then_alerted_on_discord_and_telegram(self):
        await self.start(telegram=True)
        item = self.state.item("butikk|butikk.test/produkt/playstation-5-pro-2tb/1001")
        self.assertEqual((item["availability"], item["price"], item["sku"]),
                         ("out_of_stock", 9990, "1001"))

        self.web.set(URL, product_html(price=8990, availability="InStock"))
        await self.monitor.run_once()
        self.assertEqual(len(self.notifier.sent), 1)
        msg = self.notifier.sent[0]
        self.assertIn("PÅ LAGER hos Testbutikken", msg.title)
        self.assertTrue(msg.alert)
        fields = dict(msg.fields)
        self.assertIn("9 990 kr → 8 990 kr", fields["Pris"])
        self.assertIn("Utsolgt → På lager", fields["Status"])
        self.assertEqual(fields["Kilder"], "JSON-LD ✓ · meta-tagger ✓ (2/2 enige)")
        self.assertEqual(self.web.hits[URL], 3)  # grunnlinje + oppdaget + bekreftet

        await self.notifier.drain()
        self.assertEqual(len(self.web.discord), 1)
        embed = self.web.discord[0]["embeds"][0]
        self.assertEqual(embed["url"], URL)
        self.assertIn("PÅ LAGER", embed["title"])
        self.assertEqual(len(self.web.telegram), 1)
        self.assertEqual(self.web.telegram[0]["chat_id"], "42")
        self.assertIn("PÅ LAGER", self.web.telegram[0]["text"])
        self.assertFalse(self.web.telegram[0]["disable_notification"])

    async def test_flapping_is_not_alerted(self):
        await self.start()
        target = self.target()
        self.web.set(URL, product_html(availability="InStock"))
        await self.monitor.check(target)
        key = "butikk|butikk.test/produkt/playstation-5-pro-2tb/1001"
        self.assertEqual(self.state.item(key)["pending"]["count"], 1)
        self.assertEqual(self.state.item(key)["availability"], "out_of_stock")
        # Rask ny sjekk er planlagt for å bekrefte.
        self.assertLessEqual(target.next_due - time.monotonic(), 1)

        self.web.set(URL, product_html(availability="OutOfStock"))
        await self.monitor.check(target)
        self.assertIsNone(self.state.item(key)["pending"])
        self.assertEqual(self.notifier.sent, [])
        self.assertGreater(target.next_due - time.monotonic(), 60)

    async def test_price_drop_and_insignificant_change(self):
        await self.start()
        self.web.set(URL, product_html(price=8490))
        await self.monitor.run_once()
        self.assertEqual(len(self.notifier.sent), 1)
        self.assertIn("Prisfall", self.notifier.sent[0].title)
        self.assertIn("−1 500 kr, −15,0 %", dict(self.notifier.sent[0].fields)["Pris"])
        self.assertFalse(self.notifier.sent[0].alert)

        self.web.set(URL, product_html(price=8490.5))
        await self.monitor.run_once()
        self.assertEqual(len(self.notifier.sent), 1)  # under min_price_change: ingen varsel
        self.assertEqual(self.state.item("butikk|butikk.test/produkt/playstation-5-pro-2tb/1001")
                         ["price"], 8490.5)

        self.web.set(URL, product_html(price=9990))
        await self.monitor.run_once()
        self.assertIn("Prisøkning", self.titles()[-1])

    async def test_price_alerts_can_be_turned_off(self):
        self.cfg.settings.notify_price_changes = False
        await self.start()
        self.web.set(URL, product_html(price=5000))
        await self.monitor.run_once()
        self.assertEqual(self.notifier.sent, [])

    async def test_sold_out_alert_and_setting(self):
        self.web.set(URL, product_html(availability="InStock"))
        await self.start()
        self.web.set(URL, product_html(availability="SoldOut"))
        await self.monitor.run_once()
        self.assertEqual(len(self.notifier.sent), 1)
        self.assertIn("🔴 Utsolgt hos Testbutikken", self.notifier.sent[0].title)

        self.cfg.settings.notify_sold_out = False
        self.web.set(URL, product_html(availability="InStock"))
        await self.monitor.run_once()
        self.web.set(URL, product_html(availability="OutOfStock"))
        await self.monitor.run_once()
        self.assertEqual(len(self.notifier.sent), 2)  # bare påfyllingen ble varslet
        self.assertIn("PÅ LAGER", self.titles()[-1])

    async def test_preorder_to_in_stock_counts_as_restock(self):
        self.web.set(URL, product_html(availability="PreOrder"))
        await self.start()
        self.web.set(URL, product_html(availability="InStock"))
        await self.monitor.run_once()
        self.assertTrue(self.notifier.sent[0].alert)

    async def test_conflicting_sources_are_flagged(self):
        await self.start()
        html = product_html(availability="InStock").replace("in stock", "out of stock")
        # jsonld (vekt 3) sier på lager, meta (vekt 2) sier utsolgt.
        self.web.set(URL, html)
        await self.monitor.run_once()
        self.assertEqual(len(self.notifier.sent), 1)
        self.assertIn("uenige", dict(self.notifier.sent[0].fields)["Obs"])

    async def test_page_gone_becomes_discontinued(self):
        await self.start()
        del self.web.pages[URL]
        await self.monitor.run_once()
        item = self.state.item("butikk|butikk.test/produkt/playstation-5-pro-2tb/1001")
        self.assertEqual(item["availability"], "discontinued")
        self.assertIn("Ny status", self.titles()[0])
        self.assertEqual(self.monitor.stores_down(), {})

    async def test_unreadable_page_keeps_last_status_and_counts_as_failure(self):
        await self.start()
        self.web.set(URL, "<html><head><title>Vedlikehold</title></head><body></body></html>")
        await self.monitor.run_once()
        item = self.state.item("butikk|butikk.test/produkt/playstation-5-pro-2tb/1001")
        self.assertEqual(item["availability"], "out_of_stock")
        self.assertIn("fant verken pris", item["error"])
        self.assertIn("Testbutikken", self.monitor.stores_down())
        self.assertEqual(self.notifier.sent, [])

    async def test_state_survives_restart_and_changes_while_offline_are_alerted(self):
        await self.start()
        self.state.save(force=True)
        await self.monitor.fetcher.close()
        await self.notifier.close()

        self.web.set(URL, product_html(availability="InStock"))
        self.monitor, self.notifier, self.state = make_monitor(self.cfg, self.web)
        self.assertFalse(self.monitor.first_run)
        await self.monitor.run_once()
        self.assertIn("PÅ LAGER", self.titles()[0])
        history = self.cfg.history_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(history[-1])["event"], "restock")


class StoreHealthTest(Base):
    def setUp(self):
        super().setUp()
        self.cfg.stores.append(store(products=[URL]))
        self.cfg.settings.fail_threshold = 3
        self.web.set(URL, product_html())

    async def test_blocked_store_alerts_once_backs_off_and_recovers(self):
        await self.start()
        target = self.target()
        self.web.set(URL, "<html><title>Attention Required! | Cloudflare</title></html>", 403)
        delays = []
        for _ in range(4):
            await self.monitor.check(target)
            delays.append(target.next_due - time.monotonic())
        self.assertEqual(len(self.notifier.sent), 1)
        self.assertIn("Får ikke sjekket Testbutikken", self.notifier.sent[0].title)
        self.assertIn("avviser automatiske forespørsler", self.notifier.sent[0].body)
        self.assertTrue(all(b > a for a, b in zip(delays, delays[1:])), delays)
        self.assertLessEqual(max(delays), self.cfg.settings.max_backoff_seconds)

        self.web.set(URL, product_html())
        await self.monitor.check(target)
        self.assertIn("svarer igjen", self.titles()[-1])
        self.assertEqual(self.monitor.stores_down(), {})
        self.assertEqual(target.fails, 0)

    async def test_network_error_is_handled(self):
        await self.start()

        def boom(request):
            raise __import__("httpx").ConnectError("nede")

        self.monitor.fetcher.client._transport = __import__("httpx").MockTransport(boom)
        await self.monitor.check(self.target())
        self.assertIn("nettverksfeil", self.monitor.stores_down()["Testbutikken"])

    async def test_robots_txt_is_respected(self):
        self.cfg.settings.respect_robots = True
        self.web.set("https://butikk.test/robots.txt", "User-agent: *\nDisallow: /produkt/\n")
        self.monitor, self.notifier, self.state = make_monitor(self.cfg, self.web)
        await self.monitor.run_once()
        self.assertEqual(self.web.hits[URL], 0)
        self.assertIn("robots.txt", self.monitor.stores_down()["Testbutikken"])

    async def test_identifies_itself_honestly(self):
        await self.start()
        self.assertEqual(self.web.user_agents, {self.cfg.settings.user_agent})
        self.assertIn("ps5pro-vakten", self.cfg.settings.user_agent)


class DiscoveryTest(Base):
    LISTING = "https://butikk.test/kategori/playstation"
    NEW = "https://butikk.test/produkt/playstation-5-pro-2tb-fc-26-pakke/2002"
    FAKE = "https://butikk.test/produkt/playstation-5-pro-2tb/3003"

    def setUp(self):
        super().setUp()
        self.cfg.stores.append(store(products=[URL], listings=[self.LISTING],
                                     sku_regex=r"/(\d+)$"))
        self.web.set(URL, product_html())
        self.web.set(self.LISTING, self.listing())

    def listing(self, *extra: str) -> str:
        links = ['<a href="/produkt/playstation-5-pro-2tb/1001?ref=liste">PlayStation 5 Pro 2TB</a>',
                 '<a href="/produkt/ps5-pro-deksel/9009">Deksel til PS5 Pro</a>',
                 '<a href="/kategori/playstation-5-pro">PlayStation 5 Pro</a>',
                 '<a href="https://annen.test/produkt/playstation-5-pro/1">PlayStation 5 Pro</a>',
                 *extra]
        return "<html><body>" + "".join(links) + "</body></html>"

    async def test_new_listing_is_found_monitored_and_alerted(self):
        await self.start()
        self.assertEqual(len(self.monitor.targets), 2)  # produkt + oversiktsside

        self.web.set(self.NEW, product_html("PlayStation 5 Pro 2TB – EA FC 26-pakke", 10990,
                                            "InStock", sku="2002"))
        self.web.set(self.LISTING, self.listing(
            '<a href="/produkt/playstation-5-pro-2tb-fc-26-pakke/2002"><img alt=""></a>'))
        await self.monitor.run_once()
        self.assertEqual(self.state.discovered["butikk"], [self.NEW])
        self.assertEqual(len(self.notifier.sent), 1)
        msg = self.notifier.sent[0]
        self.assertIn("Ny produktside hos Testbutikken", msg.title)
        self.assertTrue(msg.alert)  # ny side som faktisk kan kjøpes
        self.assertEqual(msg.url, self.NEW)

        # Etter omstart overvåkes den oppdagede siden fortsatt, uten nytt varsel.
        self.state.save(force=True)
        monitor2, notifier2, _ = make_monitor(self.cfg, self.web)
        self.assertIsNotNone(monitor2._find_target(self.NEW))
        await monitor2.run_once()
        self.assertEqual(notifier2.sent, [])
        await monitor2.fetcher.close()
        await notifier2.close()

    async def test_discovered_page_that_is_an_accessory_is_rejected_for_good(self):
        await self.start()
        self.web.set(self.FAKE, product_html("Deksel til PS5 Pro", 399, "InStock", sku="3003"))
        self.web.set(self.LISTING, self.listing('{"url":"/produkt/playstation-5-pro-2tb/3003"}'))
        await self.monitor.run_once()
        self.assertEqual(self.notifier.sent, [])
        self.assertEqual(self.state.discovered["butikk"], [])
        self.assertIn(self.FAKE, self.state.meta["rejected"])
        hits = self.web.hits[self.FAKE]
        await self.monitor.run_once()
        self.assertEqual(self.web.hits[self.FAKE], hits)

    async def test_redirect_to_already_monitored_page_is_dropped(self):
        old = "https://butikk.test/produkt/playstation-5-pro-2tb/900"
        self.web.redirects[old] = URL
        self.cfg.stores[0].products.append(old)
        await self.start()
        self.assertTrue(self.target(old).disabled)
        self.assertEqual(len(self.state.items), 1)

    async def test_redirect_to_other_page_means_removed(self):
        self.web.redirects[URL] = "https://butikk.test/kategori/playstation"
        await self.start()
        item = self.state.item("butikk|butikk.test/produkt/playstation-5-pro-2tb/1001")
        self.assertEqual(item["availability"], "discontinued")


class PrisjaktTest(Base):
    PJ = "https://www.prisjakt.no/product.php?p=13395263"
    KOMPLETT = "https://www.komplett.no/product/1346176/playstation-5-pro-2tb"

    def setUp(self):
        super().setUp()
        self.cfg.stores.append(store(id="komplett", name="Komplett", products=[self.KOMPLETT],
                                     sku_regex=r"/product/(\d+)"))
        self.cfg.aggregators.append(aggregator(products=[self.PJ]))
        self.web.set(self.KOMPLETT, product_html(price=17990, availability="OutOfStock",
                                                 sku="1346176"))
        self.offers = [
            {"shop": "Komplett", "shop_id": 9782, "offer_id": "1346176", "price": 17990},
            {"shop": "Obs", "shop_id": 23430, "offer_id": "711719595908", "price": 10990},
        ]
        self.publish()

    def publish(self):
        self.web.set(self.PJ, prisjakt_html(self.offers))

    def offer(self, shop):
        return next(i for i in self.state.items.values()
                    if i.get("via") == "Prisjakt" and i["store"] == shop)

    async def test_only_uncovered_shops_alert_via_prisjakt(self):
        await self.start()
        self.assertTrue(self.offer("Komplett")["covered"])
        self.assertFalse(self.offer("Obs")["covered"])

        for o in self.offers:
            o["stock"] = "InStock"
        self.publish()
        await self.monitor.run_once()
        self.assertEqual(self.titles(), ["🟢 PÅ LAGER hos Obs (via Prisjakt)"])
        self.assertEqual(self.notifier.sent[0].url, self.PJ)
        # Komplett-raden er likevel oppdatert i statusen.
        self.assertEqual(self.offer("Komplett")["availability"], "in_stock")

    async def test_prisjakt_takes_over_when_store_is_blocked(self):
        await self.start()
        self.web.set(self.KOMPLETT, "Access Denied", 403)
        await self.monitor.check(self.monitor._find_target(self.KOMPLETT))
        self.offers[0]["stock"] = "InStock"
        self.publish()
        await self.monitor.run_once()
        self.assertIn("🟢 PÅ LAGER hos Komplett (via Prisjakt)", self.titles())

    async def test_new_shop_and_vanished_offer(self):
        await self.start()
        self.offers.append({"shop": "HomeIT", "shop_id": 41681, "offer_id": "NO1081",
                            "price": 9490, "stock": "InStock"})
        self.publish()
        await self.monitor.run_once()
        self.assertEqual(self.titles(), ["🆕 Nytt tilbud hos HomeIT (via Prisjakt)"])

        self.offers.pop()
        self.publish()
        await self.monitor.run_once()
        self.assertIn("🔴 Utsolgt hos HomeIT (via Prisjakt)", self.titles())
        self.assertIn("ikke lenger oppført", self.offer("HomeIT")["detail"])

    async def test_used_offers_are_ignored(self):
        self.offers.append({"shop": "Bruktbua", "price": 5000, "stock": "InStock",
                            "condition": "Used"})
        self.publish()
        await self.start()
        self.assertFalse(any(i["store"] == "Bruktbua" for i in self.state.items.values()))

    async def test_changed_page_format_is_reported_as_failure(self):
        await self.start()
        self.web.set(self.PJ, "<html><body>nytt design</body></html>")
        await self.monitor.run_once()
        self.assertIn("tilbudslisten", self.monitor.stores_down()["Prisjakt"])


class RobustnessTest(Base):
    async def test_unexpected_error_in_one_page_does_not_stop_the_rest(self):
        other = "https://annen.test/produkt/playstation-5-pro-2tb/5"
        self.cfg.stores.append(store(products=[URL]))
        self.cfg.stores.append(store(id="annen", name="Annen", products=[other]))
        self.web.set(URL, product_html())
        self.web.set(other, product_html(availability="InStock"))
        self.monitor, self.notifier, self.state = make_monitor(self.cfg, self.web)

        original = self.monitor._process_product

        def flaky(target, result):
            if target.url == URL:
                raise RuntimeError("uventet")
            return original(target, result)

        self.monitor._process_product = flaky
        with self.assertLogs("ps5monitor", level="ERROR"):
            await self.monitor.run_once()
        self.assertEqual(self.target().fails, 1)
        self.assertEqual(self.state.item("annen|annen.test/produkt/playstation-5-pro-2tb/5")
                         ["availability"], "in_stock")

    async def test_dead_host_worker_is_restarted(self):
        self.cfg.stores.append(store(products=[URL]))
        self.web.set(URL, product_html())
        self.monitor, self.notifier, self.state = make_monitor(self.cfg, self.web)

        async def crash():
            raise RuntimeError("krasj")

        self.monitor._workers["butikk.test"] = asyncio.create_task(crash())
        await asyncio.sleep(0)
        with self.assertLogs("ps5monitor", level="ERROR"):
            self.monitor._revive_workers()
        worker = self.monitor._workers["butikk.test"]
        self.assertFalse(worker.done())
        await asyncio.sleep(0.3)
        self.assertGreaterEqual(self.web.hits[URL], 1)
        worker.cancel()

    async def test_unwritable_state_file_does_not_raise(self):
        self.cfg.stores.append(store(products=[URL]))
        self.web.set(URL, product_html())
        await self.start()
        self.state.path = self.cfg.base_dir / "finnes" / "ikke" / "state.json"
        (self.cfg.base_dir / "finnes").write_text("en fil, ikke en mappe")
        self.state.touch()
        with self.assertLogs("ps5monitor", level="WARNING"):
            self.state.save(force=True)


class RunLoopTest(Base):
    async def test_continuous_run_sends_startup_summary_and_answers_commands(self):
        self.cfg.stores.append(store(products=[URL]))
        self.cfg.settings.interval_seconds = 0.2
        self.web.set(URL, product_html(price=17990, availability="InStock"))
        self.monitor, self.notifier, self.state = make_monitor(self.cfg, self.web)
        task = asyncio.create_task(self.monitor.run())
        for _ in range(60):
            await asyncio.sleep(0.1)
            if self.web.discord:
                break
        self.assertTrue(self.web.discord, "oppstartsmelding ble ikke sendt")
        embed = self.web.discord[0]["embeds"][0]
        self.assertIn("i gang", embed["title"])
        self.assertIn("1 av 1 oppføringer kan kjøpes nå", embed["description"])
        self.assertIn(f"[Testbutikken]({URL})", embed["description"])
        self.assertEqual(self.web.discord[0]["flags"], 4096)
        self.assertFalse(self.monitor.first_run)
        self.assertGreaterEqual(self.web.hits[URL], 2)  # sjekkes igjen og igjen

        reply = await self.monitor.handle_command("/status")
        self.assertIn("Status PlayStation 5 Pro", reply.title)
        self.assertIn("Pong", (await self.monitor.handle_command("/ping")).title)
        self.assertIsNone(await self.monitor.handle_command("/ukjent"))

        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.cfg.state_path.exists())


if __name__ == "__main__":
    unittest.main()

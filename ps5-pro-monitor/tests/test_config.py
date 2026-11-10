import tempfile
import unittest
from pathlib import Path

from ps5monitor.config import Config, load_config

WANTED = [
    "PlayStation 5 Pro 2TB",
    "Sony PlayStation 5 Pro (PS5) 2TB",
    "Sony PlayStation 5 Pro (2025)",
    "PlayStation®5 Pro Konsoll 2TB",
    "Sony PlayStation® 5 Pro Spillkonsoll",
    "PlayStation 5 Pro-konsoll – EA SPORTS FC™ 26-pakke",
    "PlayStation 5 Pro 2TB spillkonsoll (EA FC 26-pakke)",
    "Sony PlayStation 5 PRO Gaming-Konsole (2 TB SSD, Digital)",
    "Sony PlayStation 5 Pro + Sony DualSense Edge Wireless Controller",
    "PlayStation 5 Pro Console - 30th Anniversary Limited Edition Bundle",
    "PS5 Pro 2TB",
    "playstation-5-pro-2tb",
    "sony-playstation-5-pro-spillkonsoll-p69968",
    "sony-playstation-5-pro-gaming-konsole-2-tb-ssd-digital",
]
UNWANTED = [
    "PlayStation 5 Slim Digital Edition",
    "PS5 Pro Console Cover Wolverine YELLOW",
    "PS5 Pro-konsolldeksler – Marvel's Wolverine",
    "Deltaco GAMING PS5 Pro - Wireless Controller",
    "Diskstasjon for PlayStation 5 Slim Digital Edition/PS5 Pro",
    "Samsung 990 Pro Heatsink 2TB intern SSD for PS5",
    "Oniverse DUST FILTER SUNSET PS5 Pro",
    "PDP Victrix PS5 PRO FS Fightstick (PS5)",
    "Inskal PS5 / PS5 Pro / PS5 Slim Stand - Silver",
    "Kjølevifte til PS5 Pro / intern 19-blads vifte",
    "Sony PlayStation 5 Pro (PS5 Pro) Konsoll - 2TB (DEMO)",
    "Tony Hawk's Pro Skater 3 + 4 (PS5)",
    "Nacon Revolution 5 Pro Controller (PS4/PS5)",
    "fixed-fixps5ps-mcs-bw-dockingstasjon-til-ps5-pro-slim-svart-hvit",
    "nacon-rgb-ventilator-ps5-ps5-slim-ps5-pro",
    "PlayStation 4 Pro 1TB",
    "Les mer",
    "",
]


class WantedTest(unittest.TestCase):
    def setUp(self):
        self.cfg = Config(base_dir=Path("."))

    def test_consoles_are_wanted(self):
        for name in WANTED:
            self.assertTrue(self.cfg.is_wanted(name), msg=name)

    def test_accessories_and_other_products_are_not(self):
        for name in UNWANTED:
            self.assertFalse(self.cfg.is_wanted(name), msg=name)

    def test_mentions(self):
        self.assertTrue(self.cfg.mentions("Deksel til PS5 Pro"))
        self.assertFalse(self.cfg.mentions("Les mer"))


class LoadConfigTest(unittest.TestCase):
    def write(self, base: Path, name: str, text: str) -> None:
        (base / name).write_text(text, encoding="utf-8")

    def test_defaults_without_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(tmp)
            self.assertEqual(cfg.settings.interval_seconds, 90)
            self.assertFalse(cfg.discord.enabled or cfg.telegram.enabled)
            self.assertTrue(any("config.toml" in w for w in cfg.warnings))

    def test_reads_settings_stores_and_local_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.write(base, "config.toml", """
[discord]
webhook_url = "https://discord.com/api/webhooks/1/x"
mention = "@everyone"
[telegram]
bot_token = "1:abc"
chat_id = 12345
[monitor]
interval_seconds = 5
confirmations = 0
ukjent_valg = 1
""")
            self.write(base, "stores.toml", r"""
[[store]]
id = "komplett"
name = "Komplett"
sku_regex = '/product/(\d+)'
products = ["https://www.komplett.no/product/1/a"]
[store.markers]
in_stock = ['stockstatus-instock']
[[aggregator]]
id = "prisjakt"
name = "Prisjakt"
products = ["https://www.prisjakt.no/product.php?p=1"]
""")
            self.write(base, "stores.local.toml", """
[[store]]
id = "komplett"
products = ["https://www.komplett.no/product/2/b", "https://www.komplett.no/product/1/a"]
[[store]]
id = "min"
name = "Min butikk"
aliases = ["MinButikk.no"]
products = ["https://min.example/ps5-pro"]
""")
            cfg = load_config(base)
            self.assertTrue(cfg.discord.enabled and cfg.telegram.enabled)
            self.assertEqual(cfg.telegram.chat_id, "12345")
            self.assertEqual(cfg.settings.interval_seconds, 15)  # nedre grense
            self.assertEqual(cfg.settings.confirmations, 1)
            self.assertTrue(any("ukjent_valg" in w for w in cfg.warnings))
            komplett = cfg.stores[0]
            self.assertEqual(len(komplett.products), 2)
            self.assertEqual(komplett.sku_from_url("https://www.komplett.no/product/1346176/x"),
                             "1346176")
            self.assertEqual(komplett.markers["in_stock"], ["stockstatus-instock"])
            self.assertEqual([s.id for s in cfg.stores], ["komplett", "min"])
            self.assertIs(cfg.store_for_shop("minbutikk.no"), cfg.stores[1])
            self.assertIs(cfg.store_for_shop("Komplett.no"), komplett)
            self.assertIsNone(cfg.store_for_shop("Obs"))
            self.assertEqual(len(cfg.aggregators), 1)

    def test_shipped_store_list_loads_cleanly(self):
        root = Path(__file__).resolve().parent.parent
        cfg = load_config(root, config_path=root / "config.example.toml")
        self.assertGreaterEqual(len(cfg.stores), 10)
        self.assertEqual([w for w in cfg.warnings], [])
        for store in cfg.stores:
            for url in store.products + store.listings:
                self.assertTrue(url.startswith("https://"), msg=url)
            if store.sku_regex:
                for url in store.products:
                    self.assertTrue(store.sku_from_url(url), msg=f"{store.id}: {url}")
        self.assertEqual(cfg.store_for_shop("Proshop.no").id, "proshop")
        self.assertEqual(cfg.store_for_shop("CS MEGASTORE").id, "computersalg")
        self.assertEqual(cfg.store_for_shop("Elkjøp").id, "elkjop")


import os
from unittest import mock


class ProxyBurstTest(unittest.TestCase):
    def write(self, base, name, text):
        (base / name).write_text(text, encoding="utf-8")

    def test_proxies_from_config_file_and_env_are_merged_and_deduped(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.write(base, "config.toml", """
[monitor]
proxies = ["http://a:1", "b:2", "http://a:1"]
burst_interval_seconds = 2
burst_duration_seconds = 10
proxy_include_direct = true
""")
            self.write(base, "proxies.txt", "# kommentar\nhttp://c:3\n\nhttp://a:1\n")
            with mock.patch.dict(os.environ, {"PS5_PROXIES": "http://d:4 http://c:3"}):
                cfg = load_config(base)
            # config, så env, så fil – i den rekkefølgen, uten duplikater:
            self.assertEqual(cfg.proxies,
                             ["http://a:1", "http://b:2", "http://d:4", "http://c:3"])
            self.assertTrue(cfg.settings.proxy_include_direct)
            self.assertEqual(cfg.settings.burst_interval_seconds, 5)   # klemt opp til minimum
            self.assertEqual(cfg.settings.burst_duration_seconds, 60)  # klemt opp til minimum

    def test_invalid_proxy_is_skipped_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.write(base, "config.toml", '[monitor]\nproxies = ["ftp://nope:1", "http://ok:8080"]\n')
            cfg = load_config(base)
            self.assertEqual(cfg.proxies, ["http://ok:8080"])
            self.assertTrue(any("ugyldig proxy" in w for w in cfg.warnings))

    def test_no_proxies_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(tmp)
            self.assertEqual(cfg.proxies, [])
            self.assertTrue(cfg.settings.burst_enabled)

    def test_store_burst_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.write(base, "stores.toml", """
[[store]]
id = "a"
name = "A"
burst = false
products = ["https://a.test/ps5-pro"]
[[store]]
id = "b"
name = "B"
products = ["https://b.test/ps5-pro"]
""")
            cfg = load_config(base)
            by_id = {s.id: s for s in cfg.stores}
            self.assertFalse(by_id["a"].burst)
            self.assertTrue(by_id["b"].burst)


if __name__ == "__main__":
    unittest.main()

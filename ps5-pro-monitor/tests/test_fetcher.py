import unittest

import httpx

from ps5monitor.fetcher import Fetcher, proxy_label


class FakeClock:
    """Styrt klokke: «sleep» flytter tiden i stedet for å vente på ekte sekunder."""

    def __init__(self, start=1000.0):
        self.t = start

    def __call__(self):
        return self.t

    async def sleep(self, seconds):
        self.t += seconds


def make_fetcher(responses=None, proxies=("http://p1:1", "http://p2:1"), include_direct=False,
                 host_min_delay=10.0, respect_robots=False):
    responses = responses or {}
    clock = FakeClock()

    def handler(request):
        status, body = responses.get(request.url.host, (200, "<html><title>ok</title></html>"))
        return httpx.Response(status, text=body, headers={"content-type": "text/html"})

    fetcher = Fetcher(user_agent="test", host_min_delay=host_min_delay,
                      respect_robots=respect_robots, proxies=list(proxies),
                      include_direct=include_direct, transport=httpx.MockTransport(handler),
                      clock=clock, sleeper=clock.sleep)
    return fetcher, clock


class LabelTest(unittest.TestCase):
    def test_strips_credentials(self):
        self.assertEqual(proxy_label("http://user:pass@proxy.example:8080"), "proxy.example:8080")
        self.assertEqual(proxy_label("socks5://10.0.0.1:1080"), "10.0.0.1:1080")
        self.assertEqual(proxy_label("1.2.3.4:3128"), "1.2.3.4:3128")


class OutletBuildTest(unittest.IsolatedAsyncioTestCase):
    async def test_proxies_only_by_default(self):
        f, _ = make_fetcher()
        self.assertEqual([o.label for o in f.outlets], ["p1:1", "p2:1"])
        await f.close()

    async def test_include_direct_adds_own_ip(self):
        f, _ = make_fetcher(include_direct=True)
        self.assertEqual([o.label for o in f.outlets], ["direkte", "p1:1", "p2:1"])
        await f.close()

    async def test_no_proxies_means_direct_only(self):
        f, _ = make_fetcher(proxies=())
        self.assertEqual([o.label for o in f.outlets], ["direkte"])
        await f.close()

    async def test_duplicate_proxy_labels_are_made_unique(self):
        f, _ = make_fetcher(proxies=("http://dup:1", "https://dup:1"))
        self.assertEqual([o.label for o in f.outlets], ["dup:1", "dup:1#2"])
        await f.close()


class RotationTest(unittest.IsolatedAsyncioTestCase):
    async def test_requests_spread_across_proxies(self):
        f, clock = make_fetcher(host_min_delay=10)
        for _ in range(4):
            await f.get("https://butikk.test/p")
        self.assertEqual(f.stats.requests, {"p1:1": 2, "p2:1": 2})
        self.assertEqual(clock.t, 1010.0)  # bare én 10 s pause, resten gikk via andre proxyer
        await f.close()

    async def test_single_outlet_respects_host_delay(self):
        f, clock = make_fetcher(proxies=(), host_min_delay=10)
        await f.get("https://butikk.test/p")
        await f.get("https://butikk.test/p")
        self.assertEqual(f.stats.requests, {"direkte": 2})
        self.assertEqual(clock.t, 1010.0)
        await f.close()

    async def test_result_carries_proxy_label(self):
        f, _ = make_fetcher()
        result = await f.get("https://butikk.test/p")
        self.assertIn(result.proxy, ("p1:1", "p2:1"))
        self.assertTrue(result.ok)
        await f.close()


class HealthTest(unittest.IsolatedAsyncioTestCase):
    async def test_blocked_proxy_is_paused_then_a_healthy_one_is_used(self):
        f, clock = make_fetcher(responses={"blokk.test": (403, "nope")}, host_min_delay=10)
        first = await f.get("https://blokk.test/p")
        self.assertTrue(first.blocked)
        paused = next(o for o in f.outlets if o.label == first.proxy)
        self.assertEqual(paused.fails, 1)
        self.assertGreater(paused.cooldown_until, clock.t)
        # Neste forespørsel skal gå via den andre proxyen, som ikke er i pause.
        second = await f.get("https://blokk.test/p")
        self.assertNotEqual(second.proxy, first.proxy)
        await f.close()

    async def test_select_skips_cooling_outlet_when_another_is_ready(self):
        f, clock = make_fetcher()
        f.outlets[0].cooldown_until = clock.t + 50
        outlet, wait = f._select("butikk.test", clock.t)
        self.assertEqual(outlet.label, "p2:1")
        self.assertEqual(wait, 0.0)
        await f.close()

    async def test_all_cooling_still_fetches_without_waiting_out_the_pause(self):
        f, clock = make_fetcher()
        for o in f.outlets:
            o.cooldown_until = clock.t + 300
        result = await f.get("https://butikk.test/p")
        self.assertTrue(result.ok)
        self.assertLess(clock.t, 1050.0)  # ventet ikke ut de 300 s pausen
        await f.close()

    async def test_success_clears_failures(self):
        f, _ = make_fetcher(proxies=())
        f.outlets[0].fails = 3
        f.outlets[0].cooldown_until = 1e9
        await f.get("https://butikk.test/p")
        self.assertEqual(f.outlets[0].fails, 0)
        self.assertEqual(f.outlets[0].cooldown_until, 0.0)
        await f.close()


if __name__ == "__main__":
    unittest.main()

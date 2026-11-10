import json
import unittest

from ps5monitor.extract import collect_signals, observe, reconcile
from ps5monitor.extract import prisjakt
from ps5monitor.htmldoc import HtmlDoc
from ps5monitor.models import Availability as A
from ps5monitor.models import Signal, format_price, map_availability, parse_price

from .helpers import flight, prisjakt_html, product_html


def by_source(signals):
    return {s.source: s for s in signals}


class ParsingTest(unittest.TestCase):
    def test_parse_price_formats(self):
        cases = {
            "10790,0": 10790.0, "17990.00": 17990.0, "19.999,00": 19999.0, "10 990": 10990.0,
            "10990.000000000": 10990.0, "19.999": 19999.0, "8399.2": 8399.2,
            "10 990,-": 10990.0, "1,299.50": 1299.5, "kr 9 990": 9990.0, 10790.0: 10790.0,
            "1.299.000": 1299000.0,
        }
        for raw, expected in cases.items():
            self.assertAlmostEqual(parse_price(raw), expected, msg=repr(raw))

    def test_parse_price_rejects_junk(self):
        for raw in (None, "", "gratis", 0, "0", True, "-"):
            self.assertIsNone(parse_price(raw), msg=repr(raw))

    def test_map_availability(self):
        cases = {
            "https://schema.org/InStock": A.IN_STOCK, "http://schema.org/OutOfStock": A.OUT_OF_STOCK,
            "SoldOut": A.OUT_OF_STOCK, "https://schema.org/Discontinued": A.DISCONTINUED,
            "PreOrder": A.PREORDER, "BackOrder": A.BACKORDER, "InStoreOnly": A.IN_STORE,
            "out of stock": A.OUT_OF_STOCK, "in stock": A.IN_STOCK, "notInStock": A.OUT_OF_STOCK,
            "in_stock": A.IN_STOCK, "incoming": A.BACKORDER, "50+ stk. på lager.": A.IN_STOCK,
            "Ikke på lager.": A.OUT_OF_STOCK, "LimitedAvailability": A.IN_STOCK,
            True: A.IN_STOCK, False: A.OUT_OF_STOCK, None: A.UNKNOWN, "": A.UNKNOWN,
            "$undefined": A.UNKNOWN, "tull": A.UNKNOWN,
        }
        for raw, expected in cases.items():
            self.assertIs(map_availability(raw), expected, msg=repr(raw))

    def test_buyable(self):
        self.assertTrue(A.IN_STOCK.buyable and A.PREORDER.buyable and A.IN_STORE.buyable)
        self.assertFalse(A.OUT_OF_STOCK.buyable or A.DISCONTINUED.buyable or A.UNKNOWN.buyable)

    def test_format_price(self):
        self.assertEqual(format_price(17990), "17 990 kr")
        self.assertEqual(format_price(8399.2), "8 399,20 kr")
        self.assertEqual(format_price(None), "ukjent pris")


class StructuredSourcesTest(unittest.TestCase):
    def test_jsonld_and_meta(self):
        sig = by_source(collect_signals(product_html(price=17990, availability="InStock")))
        self.assertIs(sig["jsonld"].availability, A.IN_STOCK)
        self.assertEqual(sig["jsonld"].price, 17990)
        self.assertEqual(sig["jsonld"].sku, "1001")
        self.assertIs(sig["meta"].availability, A.IN_STOCK)
        self.assertEqual(sig["meta"].price, 17990)

    def test_jsonld_with_entity_encoded_type_attribute(self):
        # Komplett skriver type="application/ld&#x2B;json".
        html = product_html(availability="InStock").replace("ld+json", "ld&#x2B;json")
        self.assertIs(by_source(collect_signals(html))["jsonld"].availability, A.IN_STOCK)

    def test_jsonld_offer_list_skips_ex_vat_and_business_prices(self):
        ld = {"@type": "Product", "name": "PS5 Pro", "sku": "830990", "offers": [
            {"@type": "Offer", "name": "Standard Price", "price": "11999",
             "availability": "https://schema.org/SoldOut",
             "priceSpecification": [{"price": "9599.2", "valueAddedTaxIncluded": False}]},
            {"@type": "Offer", "price": "9599.2",
             "eligibleCustomerType": {"@id": "https://schema.org/Business"}},
        ]}
        html = f'<script type="application/ld+json">{json.dumps(ld)}</script>'
        sig = by_source(collect_signals(html))["jsonld"]
        self.assertEqual(sig.price, 11999)
        self.assertIs(sig.availability, A.OUT_OF_STOCK)

    def test_jsonld_price_only_in_price_specification(self):
        # NetOnNet har ingen "price" direkte på tilbudet.
        ld = {"@type": "Product", "name": "PS5 Pro", "offers": {
            "@type": "Offer", "availability": "OutOfStock",
            "priceSpecification": [{"@type": "UnitPriceSpecification", "price": "17990.00"}]}}
        html = f'<script type="application/ld+json">{json.dumps(ld)}</script>'
        self.assertEqual(by_source(collect_signals(html))["jsonld"].price, 17990)

    def test_jsonld_picks_product_matching_sku_inside_graph(self):
        graph = {"@graph": [
            {"@type": "Product", "name": "Tilbehør", "sku": "999",
             "offers": {"price": "299", "availability": "InStock"}},
            {"@type": "Product", "name": "PS5 Pro", "sku": "1001",
             "offers": {"price": "9990", "availability": "OutOfStock"}},
        ]}
        html = f'<script type="application/ld+json">{json.dumps(graph)}</script>'
        sig = by_source(collect_signals(html, sku="1001"))["jsonld"]
        self.assertEqual((sig.name, sig.price, sig.availability), ("PS5 Pro", 9990, A.OUT_OF_STOCK))

    def test_broken_jsonld_does_not_crash(self):
        html = '<script type="application/ld+json">{"@type": "Product", </script><title>X</title>'
        self.assertEqual([s.source for s in collect_signals(html)], ["title"])

    def test_microdata(self):
        html = """<span itemprop="priceCurrency" content="NOK"></span>
        <span itemprop="price" content="19999"> 19.999,00
        <meta itemprop="availability" content="https://schema.org/InStock" /></span>"""
        sig = by_source(collect_signals(html))["microdata"]
        self.assertEqual((sig.price, sig.availability), (19999, A.IN_STOCK))

    def test_microdata_price_from_text(self):
        html = '<b itemprop="price">10 990,-</b><link itemprop="availability" href="http://schema.org/SoldOut">'
        sig = by_source(collect_signals(html))["microdata"]
        self.assertEqual((sig.price, sig.availability), (10990, A.OUT_OF_STOCK))

    def test_page_without_data_gives_no_votes(self):
        obs = observe("<html><head><title>Tom side</title></head><body>Hei</body></html>")
        self.assertIs(obs.availability, A.UNKNOWN)
        self.assertIsNone(obs.price)
        self.assertEqual(obs.name, "Tom side")


class EmbeddedSourcesTest(unittest.TestCase):
    def elkjop_page(self, main: dict, sku="830990") -> str:
        accessory = {"isBuyableOnline": True, "isDiscontinued": False,
                     "onlineStock": {"inStock": True, "level": "50+"}}
        payload = (
            '114:["$","div",null,{"name":"Kontroller","sku":"220282","rating":[4.8,2472],'
            f'"sellability":{json.dumps(accessory)}' + '}]\n'
            f'115:["$","$L114",null,{{"sku":"{sku}","isBigBox":false,'
            f'"sellability":{json.dumps(main)}' + '}]\n'
            '116:{"sellability":"$f5:props:children"}\n')
        # Del opp i to biter slik Next.js gjør – dataene må leses på tvers av dem.
        half = len(payload) // 2
        return product_html(sku=sku, availability="SoldOut") + flight(payload[:half]) + \
            flight(payload[half:])

    def test_elkjop_sold_out_is_anchored_to_sku_not_accessory(self):
        html = self.elkjop_page({"isBuyableOnline": False, "isDiscontinued": False,
                                 "isBuyableInStore": False, "storesWithStockCount": 0,
                                 "onlineStock": {"inStock": False, "level": "0"},
                                 "itemAvailability": "SoldOut"})
        sig = by_source(collect_signals(html, extractor="elkjop", sku="830990"))["embedded"]
        self.assertIs(sig.availability, A.OUT_OF_STOCK)

    def test_elkjop_buyable_online(self):
        html = self.elkjop_page({"isBuyableOnline": True, "isDiscontinued": False,
                                 "onlineStock": {"inStock": True, "level": "5+"},
                                 "itemAvailability": "InStock"})
        sig = by_source(collect_signals(html, extractor="elkjop", sku="830990"))["embedded"]
        self.assertIs(sig.availability, A.IN_STOCK)
        self.assertIn("5+", sig.detail)

    def test_elkjop_store_only_and_discontinued(self):
        html = self.elkjop_page({"isBuyableOnline": False, "isBuyableInStore": True,
                                 "storesWithStockCount": 3, "isDiscontinued": False})
        sig = by_source(collect_signals(html, extractor="elkjop", sku="830990"))["embedded"]
        self.assertIs(sig.availability, A.IN_STORE)
        html = self.elkjop_page({"isBuyableOnline": False, "isDiscontinued": True})
        sig = by_source(collect_signals(html, extractor="elkjop", sku="830990"))["embedded"]
        self.assertIs(sig.availability, A.DISCONTINUED)

    def test_elkjop_unknown_sku_gives_no_signal(self):
        html = self.elkjop_page({"isBuyableOnline": True}, sku="830990")
        self.assertNotIn("embedded", by_source(collect_signals(html, extractor="elkjop", sku="111")))

    def test_kjell(self):
        def page(status, qty):
            state = {"other": {"onlineStockStatus": {"stockStatus": "inStock"}, "code": "11111"},
                     "product": {"onlineStockStatus": {"name": "Online", "stockStatus": status,
                                                       "availableQuantity": qty},
                                 "myStoreStockStatus": None, "code": "69968"}}
            return product_html(sku="69968") + f"<script>window.STATE={json.dumps(state, separators=(',', ':'))}</script>"

        sig = by_source(collect_signals(page("notInStock", -1), extractor="kjell", sku="69968"))
        self.assertIs(sig["embedded"].availability, A.OUT_OF_STOCK)
        sig = by_source(collect_signals(page("inStock", 7), extractor="kjell", sku="69968"))
        self.assertIs(sig["embedded"].availability, A.IN_STOCK)
        self.assertEqual(sig["embedded"].detail, "7 stk på nettlager")

    def test_netonnet(self):
        def page(online, shop):
            rows = [
                {"warehouseShopName": "Oslo Alnabru",
                 "location": [{"aisle": "", "articleNumber": "1060020", "type": 2}],
                 "stockLevel": shop},
                {"warehouseShopName": "Internet",
                 "location": [{"aisle": "", "articleNumber": "1060020", "type": 2}],
                 "stockLevel": online},
                {"warehouseShopName": "Internet",
                 "location": [{"aisle": "", "articleNumber": "555", "type": 2}],
                 "stockLevel": 99},
            ]
            return flight("7:" + json.dumps({"stock": rows}, separators=(",", ":")))

        def availability(html):
            return by_source(collect_signals(html, extractor="netonnet", sku="1060020"))[
                "embedded"].availability

        self.assertIs(availability(page(0, 0)), A.OUT_OF_STOCK)
        self.assertIs(availability(page(4, 0)), A.IN_STOCK)
        self.assertIs(availability(page(0, 2)), A.IN_STORE)

    def test_unknown_extractor_is_ignored(self):
        self.assertIn("jsonld", by_source(collect_signals(product_html(), extractor="finnes-ikke")))

    def test_markers(self):
        markers = {"in_stock": [r'class="[^"]*\bstockstatus-instock"\s+title="Tilgjengelighet:\s*([^"]+)"',
                                r'class="[^"]*\bstockstatus-instock\b'],
                   "out_of_stock": [r'class="stockstatus-stock-details">\s*Ikke p(?:å|&#xE5;) lager']}
        html = '<i class="icon stockstatus-instock" title="Tilgjengelighet: 50&#x2B; stk. p&#xE5; lager."></i>'
        sig = by_source(collect_signals(html, markers=markers))["markers"]
        self.assertEqual((sig.availability, sig.detail), (A.IN_STOCK, "50+ stk. på lager"))
        self.assertEqual(reconcile([Signal("jsonld", A.IN_STOCK, detail="InStock"), sig]).detail,
                         "50+ stk. på lager")
        html = '<i class="icon stockstatus-instock"></i>'
        sig = by_source(collect_signals(html, markers=markers))["markers"]
        self.assertEqual((sig.availability, sig.detail), (A.IN_STOCK, None))
        html = '<span class="stockstatus-stock-details"> Ikke p&#xE5; lager.</span>'
        self.assertIs(by_source(collect_signals(html, markers=markers))["markers"].availability,
                      A.OUT_OF_STOCK)
        self.assertNotIn("markers", by_source(collect_signals("<p>ingenting</p>", markers=markers)))


class ReconcileTest(unittest.TestCase):
    def test_agreement(self):
        obs = reconcile([Signal("jsonld", A.IN_STOCK, 17990), Signal("markers", A.IN_STOCK),
                         Signal("meta", price=17990)])
        self.assertIs(obs.availability, A.IN_STOCK)
        self.assertEqual((obs.agree, obs.total, obs.conflict), (2, 2, False))
        self.assertEqual(obs.price, 17990)
        self.assertFalse(obs.price_conflict)

    def test_majority_wins_and_conflict_is_flagged(self):
        obs = reconcile([Signal("jsonld", A.IN_STOCK), Signal("embedded", A.OUT_OF_STOCK),
                         Signal("meta", A.OUT_OF_STOCK)])
        self.assertIs(obs.availability, A.OUT_OF_STOCK)
        self.assertTrue(obs.conflict)
        self.assertEqual((obs.agree, obs.total), (2, 3))

    def test_tie_goes_to_embedded_data(self):
        # JSON-LD er ofte cachet; butikkens egne lagerdata vinner ved stemmelikhet.
        obs = reconcile([Signal("jsonld", A.OUT_OF_STOCK), Signal("embedded", A.IN_STOCK)])
        self.assertIs(obs.availability, A.IN_STOCK)
        self.assertTrue(obs.conflict)

    def test_specific_status_within_winning_side(self):
        obs = reconcile([Signal("jsonld", A.PREORDER), Signal("embedded", A.PREORDER),
                         Signal("meta", A.IN_STOCK)])
        self.assertIs(obs.availability, A.PREORDER)
        self.assertFalse(obs.conflict)

    def test_price_conflict(self):
        obs = reconcile([Signal("jsonld", A.IN_STOCK, 9990), Signal("meta", price=10990)])
        self.assertEqual(obs.price, 9990)
        self.assertTrue(obs.price_conflict)

    def test_no_signals(self):
        obs = reconcile([])
        self.assertIs(obs.availability, A.UNKNOWN)
        self.assertEqual(obs.sources_summary(), "ingen kilder")


class PrisjaktTest(unittest.TestCase):
    def test_parse_offers(self):
        html = prisjakt_html([
            {"shop": "Komplett", "shop_id": 9782, "offer_id": "1346176", "price": 17990,
             "stock": "InStock"},
            {"shop": "Obs", "shop_id": 23430, "offer_id": "711719595908", "price": 10990},
            {"shop": "Proshop.no", "price": 9990, "stock": "incoming"},
        ])
        doc = HtmlDoc(html)
        offers = prisjakt.parse_offers(doc)
        self.assertEqual([o.shop for o in offers], ["Komplett", "Obs", "Proshop.no"])
        self.assertEqual(offers[0].key, "9782-1346176")
        self.assertEqual([o.availability for o in offers],
                         [A.IN_STOCK, A.OUT_OF_STOCK, A.BACKORDER])
        self.assertEqual(offers[1].price, 10990)
        self.assertEqual(prisjakt.product_title(doc), "Sony PlayStation 5 Pro (PS5) 2TB")

    def test_page_without_offer_list(self):
        self.assertIsNone(prisjakt.parse_offers(HtmlDoc("<html><body>nei</body></html>")))
        self.assertIsNone(prisjakt.parse_offers(HtmlDoc(flight('1:{"noe":"annet"}'))))


if __name__ == "__main__":
    unittest.main()

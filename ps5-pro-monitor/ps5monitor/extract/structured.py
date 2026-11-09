"""Standardkilder som finnes hos de fleste nettbutikker: JSON-LD, meta-tagger og microdata."""

from __future__ import annotations

from ..htmldoc import HtmlDoc
from ..models import Availability, Signal, map_availability, parse_price


# --------------------------------------------------------------------------- JSON-LD
def _types(node: dict) -> set[str]:
    t = node.get("@type")
    if isinstance(t, str):
        return {t.lower()}
    if isinstance(t, list):
        return {str(x).lower() for x in t}
    return set()


def _walk_products(node, out: list[dict], depth: int = 0) -> None:
    if depth > 8:
        return
    if isinstance(node, list):
        for item in node:
            _walk_products(item, out, depth + 1)
    elif isinstance(node, dict):
        if _types(node) & {"product", "productgroup", "individualproduct"}:
            out.append(node)
        for key, value in node.items():
            if key in ("isRelatedTo", "isSimilarTo", "isAccessoryOrSparePartFor", "review"):
                continue
            if isinstance(value, (dict, list)):
                _walk_products(value, out, depth + 1)


def _offers(product: dict) -> list[dict]:
    offers = product.get("offers")
    if isinstance(offers, dict):
        inner = offers.get("offers")
        if isinstance(inner, list) and inner:
            return [o for o in inner if isinstance(o, dict)] + [offers]
        return [offers]
    if isinstance(offers, list):
        return [o for o in offers if isinstance(o, dict)]
    return []


def _offer_price(offer: dict) -> float | None:
    for key in ("price", "lowPrice"):
        price = parse_price(offer.get(key))
        if price is not None:
            return price
    spec = offer.get("priceSpecification")
    specs = spec if isinstance(spec, list) else [spec] if isinstance(spec, dict) else []
    for s in specs:
        if isinstance(s, dict) and s.get("valueAddedTaxIncluded") is not False:
            price = parse_price(s.get("price"))
            if price is not None:
                return price
    return None


def _is_business_offer(offer: dict) -> bool:
    customer = offer.get("eligibleCustomerType")
    return "business" in str(customer).lower() and "public" not in str(customer).lower()


def extract_jsonld(doc: HtmlDoc, sku_hint: str | None = None) -> Signal | None:
    products: list[dict] = []
    for data in doc.jsonld():
        _walk_products(data, products)
    if not products:
        return None

    def score(p: dict) -> int:
        s = 0
        if _offers(p):
            s += 2
        if sku_hint and str(p.get("sku", "")).strip() == sku_hint:
            s += 4
        return s

    product = max(products, key=score)
    offers = [o for o in _offers(product) if not _is_business_offer(o)] or _offers(product)

    prices = [p for p in (_offer_price(o) for o in offers) if p is not None]
    availability, raw = Availability.UNKNOWN, None
    for o in offers:
        mapped = map_availability(o.get("availability"))
        if mapped is not Availability.UNKNOWN:
            availability, raw = mapped, str(o.get("availability"))
            break
    sig = Signal(
        source="jsonld",
        availability=availability,
        price=min(prices) if prices else None,
        name=_clean(product.get("name")),
        sku=_clean(product.get("sku")),
        detail=raw.rsplit("/", 1)[-1] if raw else None,
    )
    return sig if (not sig.empty or sig.name) else None


def _clean(value) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


# --------------------------------------------------------------------------- meta
def extract_meta(doc: HtmlDoc) -> Signal | None:
    price = parse_price(
        doc.meta("product:sale_price:amount")
        or doc.meta("product:price:amount", "og:price:amount", "twitter:data1")
    )
    raw = doc.meta("product:availability", "og:availability")
    sig = Signal(
        source="meta",
        availability=map_availability(raw),
        price=price,
        name=_clean(doc.meta("og:title")),
        detail=raw,
    )
    return None if sig.empty else sig


# --------------------------------------------------------------------------- microdata
def extract_microdata(doc: HtmlDoc) -> Signal | None:
    price, availability, raw = None, Availability.UNKNOWN, None
    for item in doc.itemprops:
        value = item.get("content") or item.get("href") or item.get("value") or item.get("text")
        if item["prop"] in ("price", "lowprice") and price is None:
            price = parse_price(value)
        elif item["prop"] == "availability" and availability is Availability.UNKNOWN:
            availability = map_availability(value)
            raw = value
    sig = Signal(
        source="microdata",
        availability=availability,
        price=price,
        detail=raw.rsplit("/", 1)[-1] if raw else None,
    )
    return None if sig.empty else sig

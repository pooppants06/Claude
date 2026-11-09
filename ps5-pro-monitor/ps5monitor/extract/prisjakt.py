"""Prisjakt som ekstra kilde: tilbudsradene på en produktside dekker butikker vi ikke når direkte."""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..htmldoc import HtmlDoc, json_objects_after
from ..models import Availability, map_availability, parse_price


@dataclass
class Offer:
    shop: str
    shop_id: str
    offer_id: str
    name: str
    price: float | None
    availability: Availability
    condition: str = "new"

    @property
    def key(self) -> str:
        return f"{self.shop_id}-{self.offer_id}"


def _text(value) -> str:
    # Next.js bruker "$undefined" og "$xx:..."-referanser for tomme/delte verdier.
    if value is None or (isinstance(value, str) and value.startswith("$")):
        return ""
    return str(value)


def parse_offers(doc: HtmlDoc) -> list[Offer] | None:
    """Returnerer tilbudsradene, eller None hvis siden ikke har det forventede formatet."""
    blob = doc.flight_data()
    if not blob:
        return None
    rows = None
    for _start, _end, obj in json_objects_after(blob, "offerRows", limit=10):
        if isinstance(obj, list) and (rows is None or len(obj) > len(rows)):
            rows = obj
    if rows is None:
        return None

    offers: list[Offer] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        shop = row.get("shop") if isinstance(row.get("shop"), dict) else {}
        price = row.get("price")
        amount = price.get("amount") if isinstance(price, dict) else price
        offer_id = _text(row.get("shopOfferId")) or _text(row.get("id"))
        shop_name = _text(shop.get("name")) or _text(row.get("storeName"))
        if not shop_name or not offer_id:
            continue
        offers.append(Offer(
            shop=shop_name,
            shop_id=_text(row.get("shopId")) or re.sub(r"\W+", "", shop_name.lower()),
            offer_id=offer_id,
            name=_text(row.get("name")),
            price=parse_price(amount),
            availability=map_availability(_text(row.get("stockStatus"))),
            condition=(_text(row.get("condition")) or "new").lower(),
        ))
    return offers


def product_title(doc: HtmlDoc) -> str:
    title = doc.meta("og:title") or doc.title
    return re.split(r"\s+[-–|]\s+", " ".join(title.split()))[0]

"""Butikkspesifikke kilder: lagerdata som ligger innebygd som JSON i kildekoden.

Disse er uavhengige av JSON-LD (som ofte er cachet) og gir et ekstra «sted» å lese fra.
Alle funksjonene er forankret i produktets varenummer, slik at tilbehør og anbefalte
produkter på samme side ikke forveksles med selve produktet.
"""

from __future__ import annotations

import html
import re
from typing import Callable

from ..htmldoc import HtmlDoc, json_objects_after
from ..models import Availability, Signal, map_availability, parse_price


def elkjop(doc: HtmlDoc, sku: str | None) -> Signal | None:
    """Elkjøp: «sellability»-objektet i Next.js-dataene."""
    blob = doc.flight_data()
    chosen = None
    for start, _end, obj in json_objects_after(blob, "sellability", limit=80):
        if not isinstance(obj, dict) or "isBuyableOnline" not in obj:
            continue
        skus = re.findall(r'"sku":"([^"]+)"', blob[max(0, start - 300):start])
        if sku and skus and skus[-1] == sku:
            chosen = obj
            break
        if chosen is None and not sku:
            chosen = obj
    if chosen is None:
        return None

    stock = chosen.get("onlineStock") if isinstance(chosen.get("onlineStock"), dict) else {}
    level = str(stock.get("level", "")).strip()
    stores = chosen.get("storesWithStockCount") or 0
    item = str(chosen.get("itemAvailability") or "")
    if chosen.get("isDiscontinued"):
        availability, detail = Availability.DISCONTINUED, "utgått"
    elif chosen.get("isBuyableOnline"):
        mapped = map_availability(item)
        availability = mapped if mapped in (Availability.PREORDER, Availability.BACKORDER) \
            else Availability.IN_STOCK
        detail = f"nettlager: {level}" if level else "kan kjøpes på nett"
    elif chosen.get("isBuyableInStore") or chosen.get("isBuyableCollectAtStore") or stores:
        availability = Availability.IN_STORE
        detail = f"{stores} butikker har varen" if stores else "kan kjøpes i butikk"
    else:
        availability, detail = Availability.OUT_OF_STOCK, None
    return Signal("embedded", availability, sku=sku, detail=detail)


def kjell(doc: HtmlDoc, sku: str | None) -> Signal | None:
    """Kjell & Company: «onlineStockStatus» i sidens innebygde tilstand."""
    blob = doc.raw
    chosen = None
    for _start, end, obj in json_objects_after(blob, "onlineStockStatus", limit=40):
        if not isinstance(obj, dict) or "stockStatus" not in obj:
            continue
        # Varenummeret («code») står rett etter lagerobjektet det hører til.
        code = re.search(r'"code":"([^"]+)"', blob[end:end + 600])
        if sku and code and code.group(1) == sku:
            chosen = obj
            break
        if chosen is None and not sku:
            chosen = obj
    if chosen is None:
        return None
    status = str(chosen.get("stockStatus") or "")
    availability = map_availability(status)
    qty = chosen.get("availableQuantity")
    details = []
    if isinstance(qty, (int, float)) and qty > 0:
        details.append(f"{int(qty)} stk på nettlager")
    if chosen.get("incomingDate"):
        details.append(f"ventes {str(chosen['incomingDate'])[:10]}")
    if availability is Availability.UNKNOWN:
        details.append(status)
    return Signal("embedded", availability, sku=sku, detail=", ".join(details) or None)


_NETONNET_STOCK = re.compile(
    r'"warehouseShopName":"([^"]*)","location":\[([^\]]*)\],"stockLevel":(-?\d+)')


def netonnet(doc: HtmlDoc, sku: str | None) -> Signal | None:
    """NetOnNet: lagernivå per lager (nettlager og Lagershop) i Next.js-dataene."""
    blob = doc.flight_data()
    online = shops = 0
    seen = False
    for name, location, level in _NETONNET_STOCK.findall(blob):
        article = re.search(r'"articleNumber":"([^"]+)"', location)
        if sku and article and article.group(1) != sku:
            continue
        seen = True
        qty = max(int(level), 0)
        if name.lower() in ("internet", "distribution"):
            online += qty
        else:
            shops += qty
    if not seen:
        return None
    if online > 0:
        return Signal("embedded", Availability.IN_STOCK, sku=sku, detail=f"nettlager: {online} stk")
    if shops > 0:
        return Signal("embedded", Availability.IN_STORE, sku=sku,
                      detail=f"{shops} stk i Lagershop")
    return Signal("embedded", Availability.OUT_OF_STOCK, sku=sku)


EXTRACTORS: dict[str, Callable[[HtmlDoc, str | None], Signal | None]] = {
    "elkjop": elkjop,
    "kjell": kjell,
    "netonnet": netonnet,
}


# --------------------------------------------------------------------------- markører
_MARKER_ORDER = (
    ("discontinued", Availability.DISCONTINUED),
    ("out_of_stock", Availability.OUT_OF_STOCK),
    ("preorder", Availability.PREORDER),
    ("backorder", Availability.BACKORDER),
    ("in_store", Availability.IN_STORE),
    ("in_stock", Availability.IN_STOCK),
)


def extract_markers(doc: HtmlDoc, markers: dict) -> Signal | None:
    """Regex-markører fra stores.toml som slår til på HTML-en rundt kjøpsknapp/lagerstatus.

    Negative markører sjekkes først. Uten treff gir kilden ingen stemme.
    """
    if not markers:
        return None
    price = None
    for pattern in markers.get("price", []):
        m = re.search(pattern, doc.raw, re.I | re.S)
        if m:
            price = parse_price(m.group(1) if m.groups() else m.group(0))
            break
    for key, status in _MARKER_ORDER:
        for pattern in markers.get(key, []):
            m = re.search(pattern, doc.raw, re.I | re.S)
            if m:
                # En fangstgruppe i mønsteret brukes som detaljtekst («50+ stk. på lager»).
                detail = None
                if m.groups() and m.group(1):
                    text = re.sub(r"<[^>]+>", " ", html.unescape(m.group(1)))
                    detail = " ".join(text.split()).rstrip(".")[:60] or None
                return Signal("markers", status, price=price, detail=detail)
    if price is not None:
        return Signal("markers", price=price)
    return None

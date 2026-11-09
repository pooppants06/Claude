"""Felles datatyper og tolking av pris-/lagerverdier."""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass, field
from typing import Any


class Availability(str, enum.Enum):
    IN_STOCK = "in_stock"
    IN_STORE = "in_store"  # kun i fysisk butikk
    PREORDER = "preorder"
    BACKORDER = "backorder"
    OUT_OF_STOCK = "out_of_stock"
    DISCONTINUED = "discontinued"
    UNKNOWN = "unknown"

    @property
    def buyable(self) -> bool:
        return self in _BUYABLE

    @property
    def label(self) -> str:
        return _LABELS[self]

    @property
    def emoji(self) -> str:
        return _EMOJI[self]


_BUYABLE = {
    Availability.IN_STOCK,
    Availability.IN_STORE,
    Availability.PREORDER,
    Availability.BACKORDER,
}

_LABELS = {
    Availability.IN_STOCK: "På lager",
    Availability.IN_STORE: "Kun i butikk",
    Availability.PREORDER: "Forhåndsbestilling",
    Availability.BACKORDER: "Bestillingsvare",
    Availability.OUT_OF_STOCK: "Utsolgt",
    Availability.DISCONTINUED: "Utgått",
    Availability.UNKNOWN: "Ukjent",
}

_EMOJI = {
    Availability.IN_STOCK: "🟢",
    Availability.IN_STORE: "🏬",
    Availability.PREORDER: "🟡",
    Availability.BACKORDER: "🟡",
    Availability.OUT_OF_STOCK: "🔴",
    Availability.DISCONTINUED: "⚫",
    Availability.UNKNOWN: "❔",
}

# Normaliserte nøkler (kun bokstaver, små) -> status.
_TOKENS: dict[str, Availability] = {}
for _status, _words in {
    Availability.IN_STOCK: (
        "instock onlineonly limitedavailability lowstock lowinstock available "
        "pålager stocked alwaysinstock yes true"
    ),
    Availability.IN_STORE: "instoreonly kunibutikk",
    Availability.PREORDER: (
        "preorder presale presales forhåndsbestilling forhåndsbestill salesstart"
    ),
    Availability.BACKORDER: "backorder bestillingsvare madetoorder buytoorder incoming",
    Availability.OUT_OF_STOCK: (
        "outofstock soldout notinstock ikkepålager utsolgt unavailable notavailable "
        "none no false reserved"
    ),
    Availability.DISCONTINUED: "discontinued utgått utgår phaseout expired",
}.items():
    for _w in _words.split():
        _TOKENS[_w] = _status


def map_availability(value: Any) -> Availability:
    """Oversetter en vilkårlig lagerverdi (schema.org-URL, enum, tekst, bool) til status."""
    if value is None:
        return Availability.UNKNOWN
    if isinstance(value, Availability):
        return value
    if isinstance(value, bool):
        return Availability.IN_STOCK if value else Availability.OUT_OF_STOCK
    s = str(value).strip().lower()
    if not s:
        return Availability.UNKNOWN
    s = re.sub(r"^https?://(www\.)?schema\.org/", "", s)
    key = re.sub(r"[^a-zæøå]", "", s)
    if key in _TOKENS:
        return _TOKENS[key]
    # Fritekst: sjekk negative fraser først ("ikke på lager" inneholder "på lager").
    if "discontinu" in key or "utgått" in key:
        return Availability.DISCONTINUED
    if any(w in key for w in ("outofstock", "soldout", "utsolgt", "ikkepålager", "notinstock",
                              "ikketilgjengelig", "unavailable", "notavailable")):
        return Availability.OUT_OF_STOCK
    if "preorder" in key or "forhånd" in key:
        return Availability.PREORDER
    if "backorder" in key or "bestillingsvare" in key:
        return Availability.BACKORDER
    if "instock" in key or "pålager" in key:
        return Availability.IN_STOCK
    return Availability.UNKNOWN


def parse_price(value: Any) -> float | None:
    """Tolker «10 990,-», «19.999,00», «17990.00», 10790.0 osv. til et tall."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    s = re.sub(r"[^\d.,]", "", str(value).replace(" ", " "))
    s = s.strip(".,")
    if not s or not any(c.isdigit() for c in s):
        return None
    last_comma, last_dot = s.rfind(","), s.rfind(".")
    if last_comma >= 0 and last_dot >= 0:
        dec = max(last_comma, last_dot)
        whole, frac = s[:dec], s[dec + 1:]
        s = re.sub(r"[.,]", "", whole) + "." + frac
    elif last_comma >= 0 or last_dot >= 0:
        sep = "," if last_comma >= 0 else "."
        parts = s.split(sep)
        tail = parts[-1]
        # «19.999» / «1,299» / «1.299.000» er tusenskille; «17990.00» / «10790,0» er desimaler.
        if len(parts) > 2 or (len(tail) == 3 and 1 <= len(parts[0]) <= 3):
            s = "".join(parts)
        else:
            s = "".join(parts[:-1]) + "." + tail
    try:
        price = float(s)
    except ValueError:
        return None
    return price if price > 0 else None


def format_price(price: float | None) -> str:
    if price is None:
        return "ukjent pris"
    if abs(price - round(price)) < 0.005:
        return f"{int(round(price)):,}".replace(",", " ") + " kr"
    return f"{price:,.2f}".replace(",", " ").replace(".", ",") + " kr"


# Navn på kildene slik de vises i varsler.
SOURCE_LABELS = {
    "jsonld": "JSON-LD",
    "embedded": "lagerdata",
    "microdata": "microdata",
    "meta": "meta-tagger",
    "markers": "lagermarkør",
}


@dataclass
class Signal:
    """Én observasjon fra ett sted i kildekoden."""

    source: str
    availability: Availability = Availability.UNKNOWN
    price: float | None = None
    name: str | None = None
    sku: str | None = None
    detail: str | None = None

    @property
    def empty(self) -> bool:
        return self.availability is Availability.UNKNOWN and self.price is None

    def brief(self) -> str:
        parts = []
        if self.availability is not Availability.UNKNOWN:
            parts.append(self.availability.label)
        if self.price is not None:
            parts.append(format_price(self.price))
        text = ", ".join(parts) or "ingen data"
        if self.detail:
            text += f" ({self.detail})"
        return text


@dataclass
class Observation:
    """Sammenstilt resultat for én produktside."""

    availability: Availability = Availability.UNKNOWN
    price: float | None = None
    name: str | None = None
    sku: str | None = None
    detail: str | None = None
    signals: list[Signal] = field(default_factory=list)
    agree: int = 0
    total: int = 0
    conflict: bool = False
    price_conflict: bool = False

    def sources_summary(self) -> str:
        signals = [s for s in self.signals if not s.empty]
        if not signals:
            return "ingen kilder"
        bits = []
        for s in signals:
            if s.availability is Availability.UNKNOWN:
                mark = "·"
            elif s.availability.buyable == self.availability.buyable:
                mark = "✓"
            else:
                mark = "✗"
            bits.append(f"{SOURCE_LABELS.get(s.source, s.source)} {mark}")
        text = " · ".join(bits)
        if self.total:
            text += f" ({self.agree}/{self.total} enige)"
        return text

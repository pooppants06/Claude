"""Leser pris og lagerstatus fra flere uavhengige steder i kildekoden og sammenstiller dem."""

from __future__ import annotations

import re
from collections import defaultdict

from ..htmldoc import HtmlDoc
from ..models import Availability, Observation, Signal
from .embedded import EXTRACTORS, extract_markers
from .structured import extract_jsonld, extract_meta, extract_microdata

# Hvor mye hver kilde teller når kildene er uenige, og hvem som vinner ved stemmelikhet.
WEIGHTS = {"embedded": 3, "jsonld": 3, "microdata": 2, "meta": 2, "markers": 2}
PRIORITY = ["embedded", "jsonld", "microdata", "meta", "markers"]


def _rank(source: str) -> int:
    return PRIORITY.index(source) if source in PRIORITY else len(PRIORITY)


def collect_signals(html: str, *, extractor: str | None = None, markers: dict | None = None,
                    sku: str | None = None) -> list[Signal]:
    doc = HtmlDoc(html)
    signals: list[Signal] = []

    jsonld = extract_jsonld(doc, sku)
    sku = sku or (jsonld.sku if jsonld else None)
    candidates = [
        jsonld,
        extract_meta(doc),
        extract_microdata(doc),
        _safe(EXTRACTORS[extractor], doc, sku) if extractor in EXTRACTORS else None,
        extract_markers(doc, markers or {}),
    ]
    for sig in candidates:
        if sig is not None:
            signals.append(sig)
    if not any(s.name for s in signals) and doc.title.strip():
        name = re.split(r"\s+[|–]\s+|\s+-\s+", " ".join(doc.title.split()))[0]
        signals.append(Signal("title", name=name))
    return signals


def _safe(fn, doc, sku):
    try:
        return fn(doc, sku)
    except Exception:  # en butikk som endrer format skal bare miste denne ene kilden
        return None


def reconcile(signals: list[Signal]) -> Observation:
    """Vektet avstemning mellom kildene.

    Først avgjøres «kan kjøpes» mot «kan ikke kjøpes», deretter den mest støttede
    konkrete statusen på vinnersiden. Uenighet flagges slik at varselet kan si fra.
    """
    obs = Observation(signals=list(signals))
    voters = sorted((s for s in signals if s.availability is not Availability.UNKNOWN),
                    key=lambda s: _rank(s.source))
    if voters:
        buy = sum(WEIGHTS.get(s.source, 1) for s in voters if s.availability.buyable)
        no = sum(WEIGHTS.get(s.source, 1) for s in voters if not s.availability.buyable)
        buyable = voters[0].availability.buyable if buy == no else buy > no
        obs.conflict = buy > 0 and no > 0

        tally: dict[Availability, int] = defaultdict(int)
        for s in voters:
            if s.availability.buyable == buyable:
                tally[s.availability] += WEIGHTS.get(s.source, 1)
        best = max(tally.values())
        winner = next(s for s in voters
                      if s.availability.buyable == buyable and tally[s.availability] == best)
        obs.availability = winner.availability
        # Detaljtekst («50+ stk. på lager») hentes fra butikkens egne data, ikke fra
        # schema.org-kodene, som bare gjentar statusen.
        obs.detail = next((s.detail for s in voters
                           if s.detail and s.source in ("embedded", "markers")
                           and s.availability.buyable == buyable), None)
        obs.total = len(voters)
        obs.agree = sum(1 for s in voters if s.availability.buyable == buyable)

    priced = sorted((s for s in signals if s.price is not None), key=lambda s: _rank(s.source))
    if priced:
        obs.price = priced[0].price
        obs.price_conflict = any(abs(s.price - obs.price) > 1.0 for s in priced)

    for s in sorted(signals, key=lambda s: _rank(s.source)):
        obs.name = obs.name or s.name
        obs.sku = obs.sku or s.sku
    return obs


def observe(html: str, **kwargs) -> Observation:
    return reconcile(collect_signals(html, **kwargs))

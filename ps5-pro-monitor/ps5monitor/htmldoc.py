"""Lettvekts HTML-leser (kun standardbiblioteket).

Samler det vi trenger fra kildekoden i ett gjennomløp: <title>, <meta>, <script>-innhold,
microdata (itemprop) og lenker.
"""

from __future__ import annotations

import html as htmllib
import json
import re
from html.parser import HTMLParser


class HtmlDoc(HTMLParser):
    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.raw = html
        self.title = ""
        self.metas: list[dict[str, str]] = []
        self.scripts: list[tuple[dict[str, str], str]] = []
        self.itemprops: list[dict[str, str]] = []
        self.links: list[tuple[str, str]] = []

        self._in_title = False
        self._script: dict[str, str] | None = None
        self._script_buf: list[str] = []
        self._link: list | None = None
        self._itemprop: dict[str, str] | None = None
        self._flight: str | None = None
        try:
            self.feed(html)
            self.close()
        except Exception:  # ufullstendig/ødelagt HTML skal aldri stoppe overvåkingen
            pass

    # -- HTMLParser-kroker -------------------------------------------------
    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title" and not self.title:
            self._in_title = True
        elif tag == "meta":
            self.metas.append(a)
        elif tag == "script":
            self._script, self._script_buf = a, []
        elif tag == "a" and a.get("href"):
            self._link = [a["href"], a.get("title") or a.get("aria-label") or ""]
        if "itemprop" in a:
            entry = {"prop": a["itemprop"].strip().lower(), "text": "", **{
                k: a[k] for k in ("content", "href", "value") if k in a}}
            self.itemprops.append(entry)
            self._itemprop = None if tag in ("meta", "link") else entry

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag == "script":
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script" and self._script is not None:
            self.scripts.append((self._script, "".join(self._script_buf)))
            self._script = None
        elif tag == "a" and self._link is not None:
            self.links.append((self._link[0], " ".join(self._link[1].split())))
            self._link = None

    def handle_data(self, data):
        if self._script is not None:
            self._script_buf.append(data)
            return
        if self._in_title:
            self.title += data
        text = data.strip()
        if not text:
            return
        if self._link is not None and len(self._link[1]) < 300:
            self._link[1] = (self._link[1] + " " + text).strip()
        if self._itemprop is not None:
            self._itemprop["text"] = text
            self._itemprop = None

    # -- Hjelpere ----------------------------------------------------------
    def meta(self, *names: str) -> str | None:
        """Første <meta> med property/name lik et av navnene."""
        wanted = {n.lower() for n in names}
        for m in self.metas:
            key = (m.get("property") or m.get("name") or "").strip().lower()
            if key in wanted and m.get("content", "").strip():
                return m["content"].strip()
        return None

    def jsonld(self) -> list:
        out = []
        for attrs, content in self.scripts:
            if "ld+json" not in attrs.get("type", "").lower():
                continue
            data = loads_lenient(content)
            if data is not None:
                out.append(data)
        return out

    def flight_data(self) -> str:
        """Dekodet Next.js «flight»-data (self.__next_f.push) – der ligger ofte lagerdata."""
        if self._flight is None:
            chunks = []
            for m in _FLIGHT_RE.finditer(self.raw):
                try:
                    chunks.append(json.loads('"' + m.group(1) + '"'))
                except ValueError:
                    continue
            self._flight = "".join(chunks)
        return self._flight


_FLIGHT_RE = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')


def loads_lenient(text: str):
    text = text.strip()
    if text.startswith("<!--"):
        text = text[4:]
    if text.endswith("-->"):
        text = text[:-3]
    for candidate in (text, htmllib.unescape(text)):
        try:
            return json.loads(candidate, strict=False)
        except ValueError:
            continue
    return None


_DECODER = json.JSONDecoder(strict=False)


def json_objects_after(blob: str, key: str, limit: int = 50):
    """Gir (posisjon, objekt) for hver forekomst av "key":{...} i en tekstblob."""
    needle = f'"{key}":'
    pos, found = 0, 0
    while found < limit:
        i = blob.find(needle, pos)
        if i < 0:
            return
        start = i + len(needle)
        while start < len(blob) and blob[start] in " \t\r\n":
            start += 1
        pos = start
        if start >= len(blob) or blob[start] not in "{[":
            continue
        try:
            obj, end = _DECODER.raw_decode(blob, start)
        except ValueError:
            continue
        found += 1
        yield i, end, obj
        pos = end

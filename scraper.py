#!/usr/bin/env python3
"""
Nuffield Health Physio Availability Scraper
============================================
Fetches physio data and appointment availability from all Nuffield Health sites
and outputs to data/sites.json for the dashboard website.

Usage:
    python scraper.py                  # Full scrape of all sites
    python scraper.py --limit 10       # Scrape only first 10 sites (testing)
    python scraper.py --slug cannock   # Scrape a single site by slug
    python scraper.py --workers 5      # Control parallelism (default: 5)
    python scraper.py --headless       # Use Playwright for JS-rendered physio names
                                       # (requires: pip install playwright && playwright install chromium)

Notes:
  - Booking page availability data (slots, next available) is scraped with
    plain requests and is always available.
  - Physio names on location pages are JavaScript-rendered.  Without --headless,
    only physios who appear in the booking JSON (i.e. those with online slots)
    will be listed.  With --headless, Playwright renders the full location page
    and extracts all physio names.
"""

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import requests
from bs4 import BeautifulSoup

# Optional Playwright support (for JS-rendered physio names on location pages)
try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

# Global Playwright browser instance (shared across threads via page-per-request)
_playwright_context = None

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = "https://www.nuffieldhealth.com"
BOOKING_BASE = "https://book.nuffieldhealth.com"
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
OUTPUT_FILE = os.path.join(DATA_DIR, "sites.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}

# Location page slugs that aren't actual clinic locations
EXCLUDED_SLUGS = {
    "faqs", "treatments", "online-appointment", "physio-treatments",
    "physiotherapy", "online", "contact", "help", "why-choose",
}

MONTH_MAP = {
    "January": 1, "February": 2, "March": 3, "April": 4,
    "May": 5, "June": 6, "July": 7, "August": 8,
    "September": 9, "October": 10, "November": 11, "December": 12,
}

# Known hospital slugs (partial list; also detected by name)
HOSPITAL_SLUGS = {
    "glasgow-hospital", "parkside", "highgate", "the-holly",
    "barbican-medical-centre", "baltimore-wharf-physiotherapy",
    "hertford", "medway", "wimbledon", "haywards-heath",
    "exeter", "hereford", "tees", "warwick", "oxford",
}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def get(url: str, retries: int = 3, delay: float = 2.0) -> requests.Response | None:
    """GET with simple retry logic."""
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:
            if attempt < retries - 1:
                time.sleep(delay * (attempt + 1))
            else:
                print(f"  [WARN] Failed {url}: {exc}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Playwright helpers (optional JS rendering)
# ---------------------------------------------------------------------------

def init_playwright():
    """Initialise a shared Playwright browser context (call once from main)."""
    global _playwright_context
    if not PLAYWRIGHT_AVAILABLE:
        print("[WARN] Playwright not installed. Run: pip install playwright && playwright install chromium")
        return
    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=True)
    _playwright_context = browser.new_context(
        user_agent=HEADERS["User-Agent"],
        locale="en-GB",
    )
    print("  Playwright initialised (headless Chromium).")


def _playwright_fetch(url: str, wait_selector: str = "h2", timeout: int = 15000) -> str | None:
    """
    Fetch a URL with Playwright and return the full rendered HTML.
    Uses a new page per call (thread-safe via context).
    """
    if not _playwright_context:
        return None
    try:
        page = _playwright_context.new_page()
        page.goto(url, timeout=timeout, wait_until="domcontentloaded")
        # Wait for physio content to appear
        try:
            page.wait_for_selector(wait_selector, timeout=5000)
        except PlaywrightTimeout:
            pass
        html = page.content()
        page.close()
        return html
    except Exception as exc:
        print(f"  [WARN] Playwright failed for {url}: {exc}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Step 1: Discover all location slugs
# ---------------------------------------------------------------------------

def get_location_slugs() -> list[str]:
    """Parse the main physio page to extract all location slugs."""
    print("Fetching location list from nuffieldhealth.com/physiotherapy …")
    resp = get(f"{BASE_URL}/physiotherapy")
    if not resp:
        print("[ERROR] Could not fetch main physio page.", file=sys.stderr)
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    slugs: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]
        # Match /physiotherapy/<slug> but not /physiotherapy/<slug>/<anything>
        m = re.match(r"^/physiotherapy/([a-z0-9][a-z0-9\-]*)$", href)
        if m:
            slug = m.group(1)
            if slug not in EXCLUDED_SLUGS:
                slugs.add(slug)

    print(f"  Found {len(slugs)} location slugs.")
    return sorted(slugs)


# ---------------------------------------------------------------------------
# Step 2: Scrape location page for physio profiles
# ---------------------------------------------------------------------------

def parse_location_page(slug: str, use_playwright: bool = False) -> dict:
    """
    Fetch /physiotherapy/<slug> and extract:
     - site name, address, phone, pricing
     - list of physio names + titles from the team section

    When use_playwright=True (and Playwright is installed), the page is rendered
    with a headless Chromium browser so JS-injected physio names are visible.
    """
    url = f"{BASE_URL}/physiotherapy/{slug}"

    if use_playwright and PLAYWRIGHT_AVAILABLE and _playwright_context:
        html = _playwright_fetch(url)
        if html:
            soup = BeautifulSoup(html, "lxml")
        else:
            resp = get(url)
            if not resp:
                return _empty_location(slug)
            soup = BeautifulSoup(resp.text, "lxml")
    else:
        resp = get(url)
        if not resp:
            return _empty_location(slug)
        soup = BeautifulSoup(resp.text, "lxml")

    # --- Site name ---
    h1 = soup.find("h1")
    name = h1.get_text(strip=True) if h1 else slug.replace("-", " ").title()
    # Strip trailing boilerplate like "| Nuffield Health"
    name = re.sub(r"\s*[\|–—]\s*Nuffield Health.*$", "", name).strip()

    # --- Site type ---
    is_hospital = (
        slug in HOSPITAL_SLUGS
        or "hospital" in slug
        or "hospital" in name.lower()
        or "clinic" in name.lower()
        or "medical" in name.lower()
    )
    site_type = "hospital" if is_hospital else "gym"

    # --- Address ---
    address = ""
    for selector in [
        {"itemprop": "address"},
        {"class": re.compile(r"address", re.I)},
        "address",
    ]:
        el = soup.find(selector) if isinstance(selector, str) else soup.find(**selector if isinstance(selector, dict) else {})
        if el:
            address = el.get_text(separator=", ", strip=True)
            break

    # Fallback: look for a postcode-ish pattern in page text
    if not address:
        m = re.search(r"([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})", resp.text)
        if m:
            address = m.group(1)

    # --- Phone ---
    phone = ""
    tel_el = soup.find("a", href=re.compile(r"^tel:"))
    if tel_el:
        phone = tel_el["href"].replace("tel:", "").strip()

    # --- Pricing ---
    pricing = "£72"
    price_m = re.search(r"£(\d+)\.00.*?initial", resp.text[:5000], re.I)
    if price_m:
        pricing = f"£{price_m.group(1)}"

    # --- Physio profiles ---
    physios = _extract_physios_from_page(soup, url)

    return {
        "slug": slug,
        "name": name,
        "type": site_type,
        "address": address,
        "phone": phone,
        "pricing": pricing,
        "location_url": url,
        "booking_url": f"{BOOKING_BASE}/physio/appointments/{slug}",
        "physios": physios,
    }


def _extract_physios_from_page(soup: BeautifulSoup, location_url: str) -> list[dict]:
    """
    Extract physio names and titles from location page.

    Nuffield Health pages use several patterns:
      - H2/H3 "Name Surname Title" (combined, e.g. "Jennifer Dunbar Senior Physiotherapist")
      - H2/H3 "Name Surname" (standalone, may appear alongside the combined form)
      - H4 "Name Surname" within a sub-section
      - data-name attributes on card elements

    We parse all of these and deduplicate by normalised first+last name.
    """
    # Collect raw (name, title, heading_text) candidates from all headings
    candidates: list[tuple[str, str]] = []   # (clean_name, title)

    # Strategy 1: data attributes (most reliable when present)
    for el in soup.find_all(attrs={"data-name": True}):
        name = el.get("data-name", "").strip()
        title = el.get("data-title", el.get("data-role", "")).strip()
        if name:
            candidates.append((name, title))

    # Strategy 2: scan all h2/h3/h4 headings
    for h in soup.find_all(["h2", "h3", "h4"]):
        raw = h.get_text(strip=True)
        parsed = _parse_physio_heading(raw)
        if parsed:
            name, title = parsed
            # Try to get a better title from next sibling if we didn't extract one
            if not title:
                title = _extract_title_near(h)
            candidates.append((name, title))

    # Deduplicate: keep first occurrence of each normalised name
    physios = []
    seen_keys: set[str] = set()
    for name, title in candidates:
        key = _name_key(name)
        if key and key not in seen_keys:
            seen_keys.add(key)
            physios.append(_make_physio(name, title, location_url))

    return physios


def _parse_physio_heading(text: str) -> tuple[str, str] | None:
    """
    Given a heading string, try to extract a physio name (and optional title).

    Handles:
      "Jennifer Dunbar"                           → ("Jennifer Dunbar", "")
      "Jennifer Dunbar Senior Physiotherapist"    → ("Jennifer Dunbar", "Senior Physiotherapist")
      "William Salt Senior Physiotherapist"       → ("William Salt", "Senior Physiotherapist")
      "Mr William Salt"                           → ("Mr William Salt", "")

    Returns None if this doesn't look like a physio heading.
    """
    text = text.strip()
    if not text or len(text) > 80:
        return None

    # Known physio role fragments (used to split name from title)
    ROLE_FRAGMENTS = [
        "Senior Physiotherapist", "Physiotherapy Manager", "Physiotherapy Assistant",
        "Advanced Level Physiotherapist", "Physiotherapist", "Sports Therapist",
        "Rehabilitation Specialist", "Physical Therapist", "Physio Manager",
        "Personal Trainer", "Therapy Manager",
    ]

    # Try to split off a known role fragment that's appended to the name
    title_extracted = ""
    clean = text
    for role in ROLE_FRAGMENTS:
        if clean.endswith(role):
            name_part = clean[: -len(role)].strip()
            if name_part:
                clean = name_part
                title_extracted = role
                break
        elif role.lower() in clean.lower():
            # Role appears somewhere in the middle — try to isolate the name
            idx = clean.lower().find(role.lower())
            name_part = clean[:idx].strip()
            if name_part:
                clean = name_part
                title_extracted = role
                break

    if not _looks_like_physio_name(clean):
        return None

    return (clean, title_extracted)


def _looks_like_physio_name(text: str) -> bool:
    """Heuristic: does this text look like a person's name (first + last)?"""
    if len(text) < 4 or len(text) > 50:
        return False

    # Exact exclusions (case-insensitive)
    EXACT_SKIP = {
        "non members", "members", "non member", "member",
        "our team", "meet our team", "our staff",
    }
    if text.lower() in EXACT_SKIP:
        return False

    # Substring exclusions — if any of these appear in the text it's not a name
    SUBSTR_SKIP = {
        "physiotherapy", "services", "treatments", "book",
        "contact us", "location", "opening hours", "directions",
        "about us", "what we treat", "qualifications", "my qualifications",
        "professional memberships", "memberships", "my professional",
        "faqs", "feedback", "parking", "prices", "accessibility",
        "meet our", "how can i", "key special", "what is",
        "specialisation", "specialization", "approach", "philosophy",
    }
    lower = text.lower()
    if any(w in lower for w in SUBSTR_SKIP):
        return False

    # Must be at least two words
    words = text.split()
    if len(words) < 2:
        return False

    # Honorifics → first word is a title prefix, second word is the first name
    if words[0] in ("Mr", "Mrs", "Ms", "Miss", "Dr", "Prof"):
        return len(words) >= 2 and words[1][0].isupper()

    # Two+ words each starting with uppercase, all alphabetic (allows hyphens in surnames)
    def word_ok(w: str) -> bool:
        return bool(w) and w[0].isupper() and re.match(r"^[A-Za-z\-\']+$", w)

    if len(words) >= 2 and all(word_ok(w) for w in words[:2]):
        return True

    return False


def _name_key(name: str) -> str:
    """Normalised key for deduplication (lowercase, strip honorifics)."""
    words = _clean_professional_name(name).lower().split()
    # Remove honorific prefix
    if words and words[0] in ("mr", "mrs", "ms", "miss", "dr", "prof"):
        words = words[1:]
    # Use first two words as the key
    return " ".join(words[:2])


def _clean_professional_name(name: str) -> str:
    """
    Clean internal booking-system annotations from professional names.
    e.g. "Mr Sean (treats 10+) Megahy" → "Mr Sean Megahy"
    """
    # Remove parenthetical annotations like "(treats 10+)", "(18+)", etc.
    cleaned = re.sub(r"\s*\([^)]*\)", "", name)
    # Collapse multiple spaces
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _extract_title_near(heading) -> str:
    """Try to find the role/title near a physio name heading."""
    # Check the next sibling heading
    sibling = heading.find_next_sibling(["h3", "h4", "p", "span"])
    if sibling:
        text = sibling.get_text(strip=True)
        physio_roles = [
            "physiotherapist", "physio manager", "physiotherapy manager",
            "physio assistant", "rehabilitation", "sports therapist",
        ]
        if any(r in text.lower() for r in physio_roles):
            return text
    return ""


def _make_physio(name: str, title: str, profile_url: str) -> dict:
    return {"name": name, "title": title, "profile_url": profile_url}


def _empty_location(slug: str) -> dict:
    return {
        "slug": slug,
        "name": slug.replace("-", " ").title(),
        "type": "gym",
        "address": "",
        "phone": "",
        "pricing": "£72",
        "location_url": f"{BASE_URL}/physiotherapy/{slug}",
        "booking_url": f"{BOOKING_BASE}/physio/appointments/{slug}",
        "physios": [],
    }


# ---------------------------------------------------------------------------
# Step 3: Scrape booking page for availability
# ---------------------------------------------------------------------------

def parse_booking_page(slug: str) -> dict:
    """
    Fetch the booking page and extract:
     - whether online booking is possible
     - physio list (name + id from slot data)
     - next available appointment datetime string
     - total appointment slots in the next 4 weeks
    """
    url = f"{BOOKING_BASE}/physio/appointments/{slug}"
    resp = get(url)
    if not resp:
        return _empty_availability()

    # Extract the calendar JSON from script tags
    data = _extract_calendar_json(resp.text)
    if not data or "days" not in data:
        return _empty_availability()

    return _process_days(data["days"])


def _extract_calendar_json(html: str) -> dict | None:
    """
    Find and parse the JSON calendar data embedded in page script tags.
    Nuffield Health embeds a JSON object with a "days" key directly in a
    <script> tag (not as an external file).
    """
    soup = BeautifulSoup(html, "lxml")

    for script in soup.find_all("script"):
        text = script.string
        if not text or '"days"' not in text:
            continue

        # Use JSONDecoder.raw_decode to extract JSON from wherever it starts
        decoder = json.JSONDecoder()
        # Find each '{' and try parsing from that position
        for m in re.finditer(r"\{", text):
            start = m.start()
            # Quick lookahead to avoid trying every single brace
            if '"days"' not in text[start: start + 500]:
                continue
            try:
                obj, _ = decoder.raw_decode(text, start)
                if isinstance(obj, dict) and "days" in obj:
                    return obj
            except (json.JSONDecodeError, ValueError):
                continue

    return None


def _process_days(days: list) -> dict:
    """
    Process the raw days array from the booking JSON.

    Returns availability summary dict.
    """
    today = date.today()
    four_weeks_out = today + timedelta(weeks=4)

    physios_by_id: dict[str, dict] = {}
    next_available: str | None = None
    total_slots = 0
    has_any_active_day = False

    for day in days:
        if not isinstance(day, dict):
            continue

        active = day.get("active", False)
        if active:
            has_any_active_day = True

        slots = day.get("slots", [])
        if not slots:
            continue

        month_num = MONTH_MAP.get(day.get("month", ""), 0)
        if not month_num:
            continue

        try:
            d = date(int(day["year"]), month_num, int(day["day_of_month"]))
        except (KeyError, ValueError, TypeError):
            continue

        if d < today or d > four_weeks_out:
            continue

        for slot in slots:
            if not isinstance(slot, dict):
                continue

            total_slots += 1

            pid = slot.get("professional_id", "")
            pname = _clean_professional_name(slot.get("professional_name", ""))
            if pid and pid not in physios_by_id:
                physios_by_id[pid] = {
                    "id": pid,
                    "name": pname,
                    "gender": slot.get("gender", ""),
                }

            if next_available is None:
                start_time = slot.get("start_time", "")
                next_available = f"{d.isoformat()}T{start_time}" if start_time else d.isoformat()

    return {
        "online_bookable": has_any_active_day,
        "next_available": next_available,
        "slots_next_4_weeks": total_slots,
        "physios_from_booking": list(physios_by_id.values()),
    }


def _empty_availability() -> dict:
    return {
        "online_bookable": False,
        "next_available": None,
        "slots_next_4_weeks": 0,
        "physios_from_booking": [],
    }


# ---------------------------------------------------------------------------
# Step 4: Merge location + availability data
# ---------------------------------------------------------------------------

def scrape_site(slug: str, use_playwright: bool = False) -> dict:
    """Scrape a single site: location page + booking page, return merged record."""
    print(f"  Scraping: {slug}")

    location = parse_location_page(slug, use_playwright=use_playwright)
    time.sleep(0.3)  # gentle pacing between requests to same host
    availability = parse_booking_page(slug)

    # Merge physio lists: prefer location page names, supplement with booking data
    location_physio_names = {p["name"].lower() for p in location["physios"]}
    for bp in availability["physios_from_booking"]:
        if bp["name"].lower() not in location_physio_names:
            location["physios"].append({
                "name": bp["name"],
                "title": "",
                "profile_url": location["location_url"],
            })

    # Annotate booking physios with their IDs (for future deep-linking if NH adds it)
    booking_by_name = {p["name"].lower(): p for p in availability["physios_from_booking"]}
    for p in location["physios"]:
        booking_info = booking_by_name.get(p["name"].lower())
        if booking_info:
            p["id"] = booking_info["id"]
            p["bookable_online"] = True
        else:
            p["bookable_online"] = False

    return {
        **location,
        "online_bookable": availability["online_bookable"],
        "next_available": availability["next_available"],
        "slots_next_4_weeks": availability["slots_next_4_weeks"],
        "physio_count": len(location["physios"]),
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Scrape Nuffield Health physio availability")
    parser.add_argument("--limit", type=int, default=None, help="Max number of sites to scrape (for testing)")
    parser.add_argument("--slug", type=str, default=None, help="Scrape a single site by slug")
    parser.add_argument("--workers", type=int, default=5, help="Parallel worker threads (default: 5)")
    parser.add_argument("--output", type=str, default=OUTPUT_FILE, help="Output JSON file path")
    parser.add_argument(
        "--headless", action="store_true",
        help="Use Playwright headless browser to render JS on location pages "
             "(gets full physio names, not just those with online slots). "
             "Requires: pip install playwright && playwright install chromium",
    )
    args = parser.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)

    # Initialise Playwright if requested
    use_playwright = False
    if args.headless:
        if not PLAYWRIGHT_AVAILABLE:
            print("[ERROR] Playwright not installed. Run:\n  pip install playwright\n  playwright install chromium")
            sys.exit(1)
        init_playwright()
        use_playwright = True

    # Determine which slugs to scrape
    if args.slug:
        slugs = [args.slug]
    else:
        slugs = get_location_slugs()
        if args.limit:
            slugs = slugs[: args.limit]

    print(f"\nScraping {len(slugs)} sites with {args.workers} workers …\n")
    start_time = time.time()

    sites: list[dict] = []
    errors: list[str] = []

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_slug = {
            executor.submit(scrape_site, slug, use_playwright): slug
            for slug in slugs
        }
        for future in as_completed(future_to_slug):
            slug = future_to_slug[future]
            try:
                result = future.result()
                sites.append(result)
            except Exception as exc:
                print(f"  [ERROR] {slug}: {exc}", file=sys.stderr)
                errors.append(slug)

    # Sort by site name for consistent output
    sites.sort(key=lambda s: s["name"].lower())

    output = {
        "last_updated": _now_iso(),
        "scrape_duration_seconds": round(time.time() - start_time, 1),
        "total_sites": len(sites),
        "errors": errors,
        "sites": sites,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nDone. {len(sites)} sites scraped in {output['scrape_duration_seconds']}s.")
    print(f"Output: {args.output}")
    if errors:
        print(f"Errors ({len(errors)}): {', '.join(errors)}")


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    main()

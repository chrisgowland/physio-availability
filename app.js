/**
 * Nuffield Health Physio Availability Dashboard
 * Loads data/sites.json and renders the interactive table.
 */

// ============================================================
// State
// ============================================================

let allSites = [];          // raw data from JSON
let filteredSites = [];     // after search + filter
let currentSort = "name_asc";

// ============================================================
// Init
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  loadData();
  bindControls();
});

async function loadData() {
  try {
    const resp = await fetch("data/sites.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    allSites = json.sites || [];
    renderStats(json);
    renderLastUpdated(json.last_updated);
    applyFilters();

    document.getElementById("loadingState").hidden = true;
    document.getElementById("sitesTable").hidden = false;
  } catch (err) {
    console.error("Failed to load data/sites.json:", err);
    document.getElementById("loadingState").hidden = true;
    document.getElementById("errorState").hidden = false;
  }
}

// ============================================================
// Stats bar
// ============================================================

function renderStats(json) {
  const sites = json.sites || [];
  const totalPhysios = sites.reduce((n, s) => n + (s.physio_count || 0), 0);
  const bookable     = sites.filter(s => s.online_bookable).length;
  const withSlots    = sites.filter(s => s.slots_next_4_weeks > 0).length;
  const totalSlots   = sites.reduce((n, s) => n + (s.slots_next_4_weeks || 0), 0);

  document.getElementById("statSites").textContent    = sites.length.toLocaleString();
  document.getElementById("statPhysios").textContent  = totalPhysios.toLocaleString();
  document.getElementById("statBookable").textContent = bookable.toLocaleString();
  document.getElementById("statAvailable").textContent = withSlots.toLocaleString();
  document.getElementById("statTotalSlots").textContent = totalSlots.toLocaleString();
}

function renderLastUpdated(iso) {
  const el = document.getElementById("lastUpdated");
  if (!iso) { el.textContent = "Data not yet scraped"; return; }
  try {
    const d = new Date(iso);
    el.textContent = `Last updated: ${d.toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short"
    })}`;
  } catch { el.textContent = `Last updated: ${iso}`; }
}

// ============================================================
// Controls + filtering
// ============================================================

function bindControls() {
  document.getElementById("searchInput").addEventListener("input", applyFilters);
  document.getElementById("filterType").addEventListener("change", applyFilters);
  document.getElementById("filterBookable").addEventListener("change", applyFilters);
  document.getElementById("filterAvailability").addEventListener("change", applyFilters);
  document.getElementById("sortSelect").addEventListener("change", e => {
    currentSort = e.target.value;
    applyFilters();
  });

  // Column header sort clicks
  document.querySelectorAll(".sites-table th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const sortKey = th.dataset.sort;
      if (currentSort === sortKey) {
        // Toggle direction
        currentSort = sortKey.endsWith("_asc")
          ? sortKey.replace("_asc", "_desc")
          : sortKey.replace("_desc", "_asc");
      } else {
        currentSort = sortKey;
      }
      document.getElementById("sortSelect").value = currentSort;
      updateSortHeaders();
      applyFilters();
    });
  });

  // Modal close
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalBackdrop").addEventListener("click", e => {
    if (e.target === document.getElementById("modalBackdrop")) closeModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeModal();
  });
}

function applyFilters() {
  const query      = document.getElementById("searchInput").value.trim().toLowerCase();
  const typeFilter = document.getElementById("filterType").value;
  const bookFilter = document.getElementById("filterBookable").value;
  const availFilter= document.getElementById("filterAvailability").value;

  filteredSites = allSites.filter(site => {
    if (query && !site.name.toLowerCase().includes(query) &&
        !(site.address || "").toLowerCase().includes(query)) {
      return false;
    }
    if (typeFilter !== "all" && site.type !== typeFilter) return false;
    if (bookFilter === "yes" && !site.online_bookable) return false;
    if (bookFilter === "no"  &&  site.online_bookable) return false;
    if (availFilter === "has_slots" && !(site.slots_next_4_weeks > 0)) return false;
    if (availFilter === "no_slots"  &&   site.slots_next_4_weeks > 0)  return false;
    return true;
  });

  sortSites();
  renderTable();
  updateSortHeaders();

  const count = filteredSites.length;
  const total = allSites.length;
  document.getElementById("showingCount").textContent =
    count === total ? `${total} sites` : `${count} of ${total} sites`;
}

function sortSites() {
  filteredSites.sort((a, b) => {
    switch (currentSort) {
      case "name_asc":
        return a.name.localeCompare(b.name);
      case "name_desc":
        return b.name.localeCompare(a.name);
      case "slots_desc":
        return (b.slots_next_4_weeks || 0) - (a.slots_next_4_weeks || 0);
      case "slots_asc":
        return (a.slots_next_4_weeks || 0) - (b.slots_next_4_weeks || 0);
      case "next_asc":
        return compareNullLast(a.next_available, b.next_available, 1);
      case "next_desc":
        return compareNullLast(a.next_available, b.next_available, -1);
      case "physios_desc":
        return (b.physio_count || 0) - (a.physio_count || 0);
      case "physios_asc":
        return (a.physio_count || 0) - (b.physio_count || 0);
      default:
        return a.name.localeCompare(b.name);
    }
  });
}

function compareNullLast(a, b, direction) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return direction * (a < b ? -1 : a > b ? 1 : 0);
}

function updateSortHeaders() {
  const sortBase = currentSort.replace(/_asc$|_desc$/, "");
  document.querySelectorAll(".sites-table th.sortable").forEach(th => {
    const key = th.dataset.sort.replace(/_asc$|_desc$/, "");
    th.classList.remove("sort-active", "sort-desc");
    if (key === sortBase) {
      th.classList.add("sort-active");
      if (currentSort.endsWith("_desc")) th.classList.add("sort-desc");
    }
  });
}

// ============================================================
// Table rendering
// ============================================================

function renderTable() {
  const tbody = document.getElementById("tableBody");
  const noResults = document.getElementById("noResults");

  if (filteredSites.length === 0) {
    tbody.innerHTML = "";
    noResults.hidden = false;
    return;
  }

  noResults.hidden = true;
  tbody.innerHTML = filteredSites.map(site => renderRow(site)).join("");

  // Bind physio count button clicks
  tbody.querySelectorAll(".physio-count-btn[data-slug]").forEach(btn => {
    btn.addEventListener("click", () => openPhysioModal(btn.dataset.slug));
  });
}

function renderRow(site) {
  const typeBadge = site.type === "hospital"
    ? `<span class="badge badge--hospital">Hospital</span>`
    : `<span class="badge badge--gym">Gym</span>`;

  const physioBtn = (site.physio_count || 0) > 0
    ? `<button class="physio-count-btn" data-slug="${esc(site.slug)}" title="View physio team">${site.physio_count}</button>`
    : `<span class="physio-count-btn physio-count-btn--zero">0</span>`;

  const bookable = site.online_bookable
    ? `<span class="bookable-yes"><svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>Yes</span>`
    : `<span class="bookable-no">–</span>`;

  const nextAvail = site.next_available
    ? renderNextAvailable(site.next_available)
    : `<span class="next-none">No online slots</span>`;

  const slots = renderSlotsBadge(site.slots_next_4_weeks || 0);

  const bookUrl = site.booking_url;
  const profileUrl = site.location_url;

  const bookLink = site.online_bookable
    ? `<a href="${esc(bookUrl)}" target="_blank" rel="noopener" class="action-link action-link--book">
        <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
        Book now
       </a>`
    : `<span class="action-link action-link--disabled">No online booking</span>`;

  return `<tr>
    <td class="col-name">
      <div class="site-name">${esc(site.name)}</div>
      ${site.address ? `<div class="site-address">${esc(site.address)}</div>` : ""}
    </td>
    <td class="col-type">${typeBadge}</td>
    <td class="col-physios">${physioBtn}</td>
    <td class="col-bookable">${bookable}</td>
    <td class="col-next">${nextAvail}</td>
    <td class="col-slots">${slots}</td>
    <td class="col-actions">
      <div class="action-links">
        ${bookLink}
        <a href="${esc(profileUrl)}" target="_blank" rel="noopener" class="action-link">
          <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
          Site profile
        </a>
      </div>
    </td>
  </tr>`;
}

function renderNextAvailable(iso) {
  try {
    // iso may be "2026-04-07T09:00" or "2026-04-07"
    const [datePart, timePart] = iso.split("T");
    const d = new Date(datePart + "T00:00:00");
    const dateStr = d.toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short"
    });
    return `<span class="next-date">${dateStr}</span>` +
           (timePart ? `<br><span class="next-time">${timePart}</span>` : "");
  } catch {
    return `<span class="next-date">${esc(iso)}</span>`;
  }
}

function renderSlotsBadge(count) {
  let cls = "slots-badge--none";
  if (count >= 20)     cls = "slots-badge--high";
  else if (count >= 5) cls = "slots-badge--mid";
  else if (count > 0)  cls = "slots-badge--low";
  return `<span class="slots-badge ${cls}">${count}</span>`;
}

// ============================================================
// Physio modal
// ============================================================

function openPhysioModal(slug) {
  const site = allSites.find(s => s.slug === slug);
  if (!site) return;

  document.getElementById("modalTitle").textContent = `${site.name} — Physio Team`;

  const physios = site.physios || [];
  let body = "";

  if (physios.length === 0) {
    body = `<p class="no-physios-msg">No physio profile data scraped for this site. Visit the <a href="${esc(site.location_url)}" target="_blank" rel="noopener">site profile page</a> for staff details.</p>`;
  } else {
    const items = physios.map(p => {
      const tag = p.bookable_online
        ? `<span class="physio-tag physio-tag--online">Online booking</span>`
        : `<span class="physio-tag physio-tag--offline">In-clinic only</span>`;

      return `<li class="physio-item">
        <div class="physio-info">
          <div class="physio-name">${esc(p.name)}</div>
          ${p.title ? `<div class="physio-title">${esc(p.title)}</div>` : ""}
          <div class="physio-tags">${tag}</div>
        </div>
        <a href="${esc(p.profile_url || site.location_url)}" target="_blank" rel="noopener" class="physio-link">View profile ↗</a>
      </li>`;
    }).join("");

    body = `
      <p style="margin-bottom:0.75rem;font-size:0.82rem;color:var(--text-muted);">
        ${physios.length} physio${physios.length !== 1 ? "s" : ""} listed at this site.
        Profile pages link to the Nuffield Health site page where each physio's full bio is shown.
      </p>
      <ul class="physio-list">${items}</ul>
      <p style="margin-top:0.9rem;">
        <a href="${esc(site.booking_url)}" target="_blank" rel="noopener" class="action-link action-link--book" style="font-size:0.88rem;">
          Book an appointment at ${esc(site.name)} ↗
        </a>
      </p>`;
  }

  document.getElementById("modalBody").innerHTML = body;
  document.getElementById("modalBackdrop").hidden = false;
}

function closeModal() {
  document.getElementById("modalBackdrop").hidden = true;
}

// ============================================================
// Utility
// ============================================================

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

  // Sites with no appointment available in the next 7 days
  const sevenDaysOut = new Date();
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
  sevenDaysOut.setHours(23, 59, 59, 999);

  const noApptIn7Days = sites.filter(s => {
    if (!s.next_available) return true;
    const apptDate = new Date(s.next_available.split("T")[0] + "T00:00:00");
    return apptDate > sevenDaysOut;
  }).length;
  const pctNoAppt7 = sites.length > 0
    ? Math.round((noApptIn7Days / sites.length) * 100)
    : 0;

  // Average appointments per bookable site over 4 weeks
  const avgSlots = bookable > 0
    ? (totalSlots / bookable).toFixed(1)
    : "0.0";

  document.getElementById("statSites").textContent      = sites.length.toLocaleString();
  document.getElementById("statPhysios").textContent    = totalPhysios.toLocaleString();
  document.getElementById("statBookable").textContent   = bookable.toLocaleString();
  document.getElementById("statAvailable").textContent  = withSlots.toLocaleString();
  document.getElementById("statTotalSlots").textContent = totalSlots.toLocaleString();
  document.getElementById("statNoAppt7Days").textContent = `${pctNoAppt7}%`;
  document.getElementById("statAvgSlots").textContent   = avgSlots;
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
}

function applyFilters() {
  const query       = document.getElementById("searchInput").value.trim().toLowerCase();
  const typeFilter  = document.getElementById("filterType").value;
  const bookFilter  = document.getElementById("filterBookable").value;
  const availFilter = document.getElementById("filterAvailability").value;

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
      case "name_asc":   return a.name.localeCompare(b.name);
      case "name_desc":  return b.name.localeCompare(a.name);
      case "slots_desc": return (b.slots_next_4_weeks || 0) - (a.slots_next_4_weeks || 0);
      case "slots_asc":  return (a.slots_next_4_weeks || 0) - (b.slots_next_4_weeks || 0);
      case "next_asc":   return compareNullLast(a.next_available, b.next_available, 1);
      case "next_desc":  return compareNullLast(a.next_available, b.next_available, -1);
      case "physios_desc": return (b.physio_count || 0) - (a.physio_count || 0);
      case "physios_asc":  return (a.physio_count || 0) - (b.physio_count || 0);
      default: return a.name.localeCompare(b.name);
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
  const tbody    = document.getElementById("tableBody");
  const noResults = document.getElementById("noResults");

  if (filteredSites.length === 0) {
    tbody.innerHTML = "";
    noResults.hidden = false;
    return;
  }

  noResults.hidden = true;
  tbody.innerHTML = filteredSites.map(site => renderRow(site)).join("");
}

function renderRow(site) {
  const typeBadge = site.type === "hospital"
    ? `<span class="badge badge--hospital">Hospital</span>`
    : `<span class="badge badge--gym">Gym</span>`;

  const physioCell = (site.physio_count || 0) > 0
    ? `<a href="${esc(site.location_url)}" target="_blank" rel="noopener" class="physio-count-btn" title="View physio team on Nuffield Health">${site.physio_count}</a>`
    : `<span class="physio-count-btn physio-count-btn--zero">0</span>`;

  const bookable = site.online_bookable
    ? `<span class="bookable-yes"><svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>Yes</span>`
    : `<span class="bookable-no">–</span>`;

  const nextAvail = site.next_available
    ? renderNextAvailable(site.next_available)
    : `<span class="next-none">No online slots</span>`;

  const slots = renderSlotsBadge(site.slots_next_4_weeks || 0);

  const bookLink = site.online_bookable
    ? `<a href="${esc(site.booking_url)}" target="_blank" rel="noopener" class="action-link action-link--book">
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
    <td class="col-physios">${physioCell}</td>
    <td class="col-bookable">${bookable}</td>
    <td class="col-next">${nextAvail}</td>
    <td class="col-slots">${slots}</td>
    <td class="col-actions">
      <div class="action-links">
        ${bookLink}
        <a href="${esc(site.location_url)}" target="_blank" rel="noopener" class="action-link">
          <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
          Site profile
        </a>
      </div>
    </td>
  </tr>`;
}

function renderNextAvailable(iso) {
  try {
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

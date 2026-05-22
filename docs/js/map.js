// CD-11 public results map.
// Fetches:
//   ./data/cd11_precincts.geojson  (CD-11 precinct polygons, mirror of internal repo's reference)
//   ./data/latest.json             (public-safe analysis slice, populated by internal repo's publish workflow)
//   ./data/candidates.json         (candidate photos + 1-line bios)

(() => {
  const REFRESH_MS = 60 * 1000;
  const GEOJSON_URL = "./data/cd11_precincts.geojson";
  const DATA_URL = "./data/latest.json";
  const CANDIDATES_URL = "./data/candidates.json";

  // Neutral colorblind-safe palette for race-leader coloring (public map shows NO Wiener-favorable colors).
  const PALETTE = ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB"];

  const els = {
    lastUpdate: document.getElementById("last-update"),
    ballotsCounted: document.getElementById("ballots-counted"),
    citywide: document.getElementById("citywide-strip"),
    map: document.getElementById("results-map"),
    statusBanner: document.getElementById("status-banner"),
    detail: document.getElementById("candidate-detail"),
    detailTitle: document.getElementById("detail-title"),
    detailBody: document.getElementById("detail-body"),
    closeDetail: document.getElementById("close-detail"),
    toggleButtons: document.querySelectorAll(".map-toggle button"),
  };

  let leafletMap = null;
  let geojsonLayer = null;
  let geojsonData = null;
  let analysisByPrecinct = new Map();
  let lastData = null;
  let candidates = null;
  let leaderColorMap = new Map();
  let granularity = "precinct";
  let legendControl = null;

  function initMap() {
    leafletMap = L.map(els.map, { zoomControl: true, scrollWheelZoom: true }).setView([37.7649, -122.4394], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap, &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(leafletMap);
  }

  els.toggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.toggleButtons.forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      granularity = btn.dataset.granularity;
      restyleMap();
      renderLegend();
    });
  });
  els.closeDetail.addEventListener("click", () => els.detail.classList.add("hidden"));

  async function tick() {
    try {
      if (!geojsonData) {
        const gjRes = await fetch(GEOJSON_URL, { cache: "no-store" });
        if (gjRes.ok) { geojsonData = await gjRes.json(); renderMap(); }
      }
      if (!candidates) {
        const cRes = await fetch(CANDIDATES_URL, { cache: "no-store" });
        if (cRes.ok) {
          const raw = await cRes.json();
          // Build a case-insensitive lookup with last-name fallback.
          // SF DoE has emitted "WIENER, SCOTT" in past elections, but if the
          // June 2 CVR shifts to "Wiener, Scott" or "Scott Wiener", the
          // exact-match lookup would silently fail and the side panel would
          // show fallback initials instead of real photos. This builds the
          // tolerance in.
          candidates = {};
          for (const [key, value] of Object.entries(raw)) {
            if (key.startsWith("_")) continue;
            candidates[key.toUpperCase()] = value;
            const lastName = key.split(",")[0].trim().toUpperCase();
            if (lastName && !candidates[lastName]) candidates[lastName] = value;
          }
        }
      }
      const r = await fetch(DATA_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      render(await r.json());
    } catch (err) {
      console.warn("[public-map] tick failed:", err.message);
    }
  }

  function render(data) {
    lastData = data;
    analysisByPrecinct = new Map((data.precincts || []).map((p) => [p.precinct, p]));

    els.lastUpdate.textContent = `Last update: ${formatTimestamp(data.timestamp)}`;
    els.ballotsCounted.textContent = `Ballots counted: ${data.progress?.counted?.toLocaleString() || "—"}`;

    if (data.certified) {
      els.statusBanner.textContent = "CERTIFIED FINAL";
      els.statusBanner.classList.add("certified");
    }

    buildLeaderColorMap(data.candidates || []);
    renderCitywide(data.candidates || []);
    restyleMap();
    renderLegend();
  }

  function buildLeaderColorMap(cands) {
    leaderColorMap = new Map();
    const sorted = [...cands].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    sorted.forEach((c, i) => leaderColorMap.set(c.name, PALETTE[i % PALETTE.length]));
  }

  function renderCitywide(cands) {
    if (!cands.length) return;
    const total = cands.reduce((acc, c) => acc + (c.votes || 0), 0) || 1;
    const sorted = [...cands].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    els.citywide.innerHTML = `<strong>Citywide preliminary:</strong> ` +
      sorted.map((c) => `<span class="citywide-row">
        <span class="swatch" style="background:${leaderColorMap.get(c.name)}"></span>
        ${escapeHtml(c.name)} ${((c.votes / total) * 100).toFixed(1)}%
      </span>`).join("");
  }

  function renderMap() {
    if (!leafletMap || !geojsonData) return;
    if (geojsonLayer) geojsonLayer.remove();
    geojsonLayer = L.geoJSON(geojsonData, {
      style: feature => styleForFeature(feature),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        layer.bindTooltip(p.precinct_full_name || `PCT ${p.precinct}`, { sticky: true });
        layer.on("click", () => openSidePanel(p));
      },
    }).addTo(leafletMap);
    try { leafletMap.fitBounds(geojsonLayer.getBounds(), { padding: [10, 10] }); } catch (e) { /* empty */ }
  }

  function restyleMap() {
    if (!geojsonLayer) return;
    geojsonLayer.setStyle(feature => styleForFeature(feature));
  }

  function styleForFeature(feature) {
    const props = feature.properties || {};
    const data = analysisByPrecinct.get(props.precinct);
    const base = { weight: 0.7, color: "#888", fillOpacity: 0.7, fillColor: "#e0e0e0" };
    if (!data) {
      base.fillOpacity = 0.15;
      return base;
    }
    if (granularity === "precinct" && data.leader) {
      base.fillColor = leaderColorMap.get(data.leader) || "#888";
    } else if (granularity === "sup") {
      // Aggregate by supervisor_district
      const sd = props.supervisor_district;
      const leader = leaderInSupDistrict(sd);
      base.fillColor = leaderColorMap.get(leader) || "#888";
      base.weight = 0.3;
    } else if (granularity === "cd11") {
      const cwLeader = lastData?.candidates?.[0]?.name;
      base.fillColor = leaderColorMap.get(cwLeader) || "#888";
      base.weight = 0.3;
    }
    return base;
  }

  function leaderInSupDistrict(sd) {
    if (!sd || !lastData?.precincts) return null;
    const tally = {};
    for (const p of lastData.precincts) {
      if (String(p.supervisor_district) !== String(sd)) continue;
      for (const [cand, votes] of Object.entries(p.candidates || {})) {
        tally[cand] = (tally[cand] || 0) + votes;
      }
    }
    let best = null, bestVotes = -1;
    for (const [c, v] of Object.entries(tally)) if (v > bestVotes) { best = c; bestVotes = v; }
    return best;
  }

  function openSidePanel(props) {
    const data = analysisByPrecinct.get(props.precinct);
    els.detailTitle.textContent = props.precinct_full_name || `PCT ${props.precinct}`;
    if (!data) {
      els.detailBody.innerHTML = `<p class="placeholder">No data yet for this precinct.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    const total = data.total_votes || 1;
    const sortedCands = Object.entries(data.candidates || {}).sort(([, a], [, b]) => b - a);
    const rows = sortedCands.map(([name, votes]) => {
      const pct = (votes / total) * 100;
      const meta = lookupCandidate(name);
      const photo = meta.photo
        ? `<img class="photo" src="${meta.photo}" alt="">`
        : `<div class="photo">${escapeHtml(initials(name))}</div>`;
      const bio = meta.bio ? `<div class="bio">${escapeHtml(meta.bio)}</div>` : "";
      return `<div class="candidate-row">
        ${photo}
        <div class="info">
          <div class="name">${escapeHtml(name)}</div>
          ${bio}
        </div>
        <div class="num">
          <div class="pct">${pct.toFixed(1)}%</div>
          <div class="votes">${votes.toLocaleString()}</div>
        </div>
        <div class="bar-container"><div class="bar" style="width:${pct}%;background:${leaderColorMap.get(name) || "#888"}"></div></div>
      </div>`;
    }).join("");
    const turnout = (props.registered_voters && total)
      ? `<p style="font-size:0.85rem;color:var(--color-muted);margin:0.5rem 0">Total ballots counted: <strong>${total.toLocaleString()}</strong></p>`
      : `<p style="font-size:0.85rem;color:var(--color-muted);margin:0.5rem 0">Total ballots counted: <strong>${total.toLocaleString()}</strong></p>`;
    els.detailBody.innerHTML = `${turnout}${rows}
      <p style="font-size:0.8rem;color:var(--color-muted);margin-top:1rem">Updated ${formatTimestamp(lastData?.timestamp)}. Preliminary until certified.</p>`;
    els.detail.classList.remove("hidden");
  }

  function renderLegend() {
    if (!leafletMap || !leaderColorMap.size) return;
    if (legendControl) { legendControl.remove(); legendControl = null; }
    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
      const div = L.DomUtil.create("div", "legend");
      div.innerHTML = `<strong>Race leader</strong>` + [...leaderColorMap.entries()].map(([n, c]) =>
        `<div class="legend-row"><span class="legend-swatch" style="background:${c}"></span> ${escapeHtml(n)}</div>`
      ).join("");
      return div;
    };
    legendControl.addTo(leafletMap);
  }

  function initials(name) {
    return name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase() || "").join("");
  }

  function lookupCandidate(name) {
    // Tolerant lookup: try exact-uppercase first, then last-name token.
    if (!candidates || !name) return {};
    const upper = name.toUpperCase().trim();
    if (candidates[upper]) return candidates[upper];
    // "Scott Wiener" or "WIENER, SCOTT" -> last name "WIENER"
    const tokens = upper.split(/[\s,]+/).filter(Boolean);
    for (const tok of tokens) {
      if (candidates[tok]) return candidates[tok];
    }
    return {};
  }

  function formatTimestamp(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  initMap();
  tick();
  setInterval(tick, REFRESH_MS);
})();

// CD-11 public results map.
// Three map layers, one per toggle:
//   ./data/cd11_precincts.geojson  -> precinct polygons (Precinct view)
//   ./data/sup_districts.geojson   -> 11 supervisor-district polygons (Supervisor district view)
//   ./data/cd11_outline.geojson    -> single CD-11 outline (All CD-11 view)
// Toggling swaps the geometry layer, so precinct lines are replaced by the
// coarser boundaries rather than merely recolored.
// Plus:
//   ./data/<snapshot>.json         -> public-safe results slice
//   ./data/candidates.json         -> photos + bios + _display config

(() => {
  const REFRESH_MS = 60 * 1000;
  const GEOJSON_URLS = {
    precinct: "./data/cd11_precincts.geojson",
    sup: "./data/sup_districts.geojson",
    cd11: "./data/cd11_outline.geojson",
  };
  const DATA_URL = "./data/latest.json";
  const CANDIDATES_URL = "./data/candidates.json";
  const NHOOD_URL = "./data/neighborhood_labels.json";
  const NHOOD_HIDE_ZOOM = 15;  // hide neighborhood labels once zoomed in past this

  const PALETTE = ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB"];

  const els = {
    lastUpdate: document.getElementById("last-update"),
    ballotsCounted: document.getElementById("ballots-counted"),
    turnout: document.getElementById("turnout"),
    citywide: document.getElementById("citywide-strip"),
    map: document.getElementById("results-map"),
    statusBanner: document.getElementById("status-banner"),
    detail: document.getElementById("candidate-detail"),
    detailTitle: document.getElementById("detail-title"),
    detailBody: document.getElementById("detail-body"),
    closeDetail: document.getElementById("close-detail"),
    toggleButtons: document.querySelectorAll("#granularity-toggle button"),
    colorButtons: document.querySelectorAll("#colormode-toggle button"),
  };

  let leafletMap = null;
  const geo = { precinct: null, sup: null, cd11: null };     // raw GeoJSON
  const layers = { precinct: null, sup: null, cd11: null };  // Leaflet layers
  let activeKey = null;
  let didFit = false;
  let analysisByPrecinct = new Map();
  let lastData = null;
  let candidates = null;
  let leaderColorMap = new Map();
  let granularity = "precinct";
  let legendControl = null;
  let displayConfig = { mode: "all" };
  let precinctToSD = new Map();  // precinct id -> supervisor_district (from precinct GeoJSON)
  let selectedLayer = null;      // currently clicked feature (border-highlighted)
  const SELECTED_STYLE = { weight: 4, color: "#f89828" };  // border-only selection highlight
  let colorMode = "leader";      // "leader" | a candidate name -> heat-map of that candidate's share
  let heatDomain = {};           // candidate name -> {min,max} observed precinct-share range
  const HEAT_NAMES = ["SCOTT WIENER", "CONNIE CHAN", "SAIKAT CHAKRABARTI"];
  let nhoodLabels = null;        // [{name,lat,lon}] curated neighborhood labels
  let nhoodLayer = null;         // Leaflet layerGroup of neighborhood label markers

  function initMap() {
    leafletMap = L.map(els.map, { zoomControl: true, scrollWheelZoom: true }).setView([37.7649, -122.4394], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap, &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(leafletMap);
    // Curated neighborhood labels are drawn in a dedicated pane ABOVE the
    // choropleth (overlayPane z-index 400) with pointer-events off so precinct
    // clicks still work underneath. We render OUR OWN labels (not CARTO's place
    // labels, which reflow and collide on zoom) and hide them once zoomed in
    // past NHOOD_HIDE_ZOOM so they don't clutter precinct-level inspection.
    leafletMap.createPane("nhoodLabels");
    leafletMap.getPane("nhoodLabels").style.zIndex = 650;
    leafletMap.getPane("nhoodLabels").style.pointerEvents = "none";
    leafletMap.on("zoomend", updateNeighborhoodLabelVisibility);
  }

  // Curated neighborhood labels (data/neighborhood_labels.json), positioned at
  // geometry-derived centroids. Fixed positions -> they never reflow/collide on
  // zoom the way the CARTO place labels did.
  function buildNeighborhoodLabels() {
    if (!leafletMap || !nhoodLabels) return;
    nhoodLayer = L.layerGroup();
    for (const n of nhoodLabels) {
      const icon = L.divIcon({ className: "nhood-label", html: `<span>${escapeHtml(n.name)}</span>`, iconSize: [0, 0] });
      L.marker([n.lat, n.lon], { icon, pane: "nhoodLabels", interactive: false, keyboard: false }).addTo(nhoodLayer);
    }
    updateNeighborhoodLabelVisibility();
  }
  function updateNeighborhoodLabelVisibility() {
    if (!leafletMap || !nhoodLayer) return;
    const show = leafletMap.getZoom() < NHOOD_HIDE_ZOOM;
    if (show && !leafletMap.hasLayer(nhoodLayer)) nhoodLayer.addTo(leafletMap);
    else if (!show && leafletMap.hasLayer(nhoodLayer)) leafletMap.removeLayer(nhoodLayer);
  }

  els.toggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.toggleButtons.forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      clearSelection();
      granularity = btn.dataset.granularity;
      showActiveLayer();
      renderLegend();
    });
  });
  els.closeDetail.addEventListener("click", () => { els.detail.classList.add("hidden"); clearSelection(); });

  // "Color by" toggle: race leader (categorical) vs. a single candidate's vote
  // share (sequential heat map). Orthogonal to the precinct/SD/CD-11 granularity.
  els.colorButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.colorButtons.forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      colorMode = btn.dataset.colormode;
      restyleActive();
      updateTooltips();
      renderLegend();
    });
  });

  async function tick() {
    try {
      for (const key of Object.keys(GEOJSON_URLS)) {
        if (geo[key]) continue;
        const res = await fetch(GEOJSON_URLS[key], { cache: "no-store" });
        if (res.ok) geo[key] = await res.json();
      }
      if (geo.precinct && precinctToSD.size === 0) {
        precinctToSD = new Map(
          (geo.precinct.features || []).map((f) => [f.properties?.precinct, f.properties?.supervisor_district])
        );
      }
      buildLayers();

      if (!candidates) {
        const cRes = await fetch(CANDIDATES_URL, { cache: "no-store" });
        if (cRes.ok) {
          const raw = await cRes.json();
          candidates = {};
          if (raw._display && typeof raw._display === "object") displayConfig = raw._display;
          for (const [key, value] of Object.entries(raw)) {
            if (key.startsWith("_")) continue;
            candidates[key.toUpperCase()] = value;
            const lastName = key.split(",")[0].trim().toUpperCase();
            if (lastName && !candidates[lastName]) candidates[lastName] = value;
          }
        }
      }
      if (!nhoodLabels) {
        const nRes = await fetch(NHOOD_URL, { cache: "no-store" });
        if (nRes.ok) { nhoodLabels = await nRes.json(); buildNeighborhoodLabels(); }
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
    renderTurnout(data.turnout);

    // Awaiting state: pre-poll-close, Logic & Accuracy test CVR, or any drop
    // with no results yet. Show a calm waiting banner instead of a misleading
    // "PRELIMINARY" with an empty map.
    const awaiting =
      data.status === "Awaiting results" ||
      ((data.candidates || []).length === 0 && (data.precincts || []).length === 0);

    // Reflect certification all three ways — never latch on "CERTIFIED FINAL".
    if (awaiting) {
      els.statusBanner.textContent = "AWAITING RESULTS — POLLS CLOSE AT 8 PM, JUNE 2";
      els.statusBanner.classList.remove("certified");
    } else if (data.certified) {
      els.statusBanner.textContent = "CERTIFIED FINAL";
      els.statusBanner.classList.add("certified");
    } else {
      els.statusBanner.textContent = "PRELIMINARY — RESULTS WILL CHANGE AS BALLOTS ARE COUNTED";
      els.statusBanner.classList.remove("certified");
    }

    buildLeaderColorMap(data.candidates || []);
    computeHeatDomains(data);
    renderCitywide(data.candidates || []);
    restyleActive();
    updateTooltips();
    renderLegend();
  }

  function buildLeaderColorMap(cands) {
    leaderColorMap = new Map();
    const sorted = [...cands].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    sorted.forEach((c, i) => leaderColorMap.set(c.name, PALETTE[i % PALETTE.length]));
  }

  function nameTokens(name) {
    return new Set(String(name).toUpperCase().split(/[\s,]+/).filter((t) => t.length > 2));
  }

  // Reduce a sorted [name, votes] list to the candidates the dashboard should show.
  function pickDisplay(sortedEntries) {
    const mode = displayConfig?.mode;
    if (mode === "topN") {
      return sortedEntries.slice(0, displayConfig.n || sortedEntries.length);
    }
    if (mode === "featured" && Array.isArray(displayConfig.featured)) {
      const byName = new Map(sortedEntries.map((e) => [e[0].toUpperCase(), e]));
      const out = [];
      for (const want of displayConfig.featured) {
        const upper = want.toUpperCase();
        if (byName.has(upper)) { out.push(byName.get(upper)); continue; }
        const wantTok = nameTokens(want);
        const hit = sortedEntries.find(([n]) => {
          const t = nameTokens(n);
          return [...wantTok].some((x) => t.has(x));
        });
        if (hit && !out.includes(hit)) out.push(hit);
      }
      return out.length ? out : sortedEntries;
    }
    return sortedEntries;
  }

  // Turnout = ballots cast / registered voters. Prefer CD-11 (available once
  // precinct/SOV data lands at Report 4); fall back to citywide SF (available
  // from Report 1). Either may be null early in the night.
  function renderTurnout(turnout) {
    if (!els.turnout) return;
    const t = turnout || {};
    const block = t.cd11 || t.citywide;
    if (!block || !block.registered) {
      els.turnout.textContent = "Turnout: —";
      return;
    }
    const scope = t.cd11 ? "CD-11" : "citywide";
    const cast = (block.ballots_cast || 0).toLocaleString();
    const reg = block.registered.toLocaleString();
    const pct = block.pct != null ? (block.pct * 100).toFixed(1) + "%" : "—";
    els.turnout.textContent = `Turnout (${scope}): ${cast} — ${pct} of ${reg} registered`;
  }

  function renderCitywide(cands) {
    if (!cands.length) return;
    const total = cands.reduce((acc, c) => acc + (c.votes || 0), 0) || 1;
    const sorted = [...cands].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    const shown = pickDisplay(sorted.map((c) => [c.name, c.votes || 0]));
    const label = lastData?.certified ? "Citywide certified:" : "Citywide preliminary:";
    els.citywide.innerHTML = `<strong>${label}</strong> ` +
      shown.map(([name, votes]) => `<span class="citywide-row">
        <span class="swatch" style="background:${leaderColorMap.get(name)}"></span>
        ${escapeHtml(name)} ${((votes / total) * 100).toFixed(1)}% (${votes.toLocaleString()})
      </span>`).join("");
  }

  // ---- layers ---------------------------------------------------------------

  function buildLayers() {
    if (!leafletMap) return;
    for (const key of Object.keys(GEOJSON_URLS)) {
      if (layers[key] || !geo[key]) continue;
      layers[key] = L.geoJSON(geo[key], {
        style: (feature) => styleFor(key, feature),
        onEachFeature: (feature, layer) => {
          layer.on("click", () => { selectFeature(layer); openPanel(key, feature.properties || {}); });
          layer.bindTooltip(tooltipFor(key, feature.properties || {}), { sticky: true });
        },
      });
    }
    showActiveLayer();
  }

  function showActiveLayer() {
    if (!leafletMap) return;
    const key = granularity in layers ? granularity : "precinct";
    if (!layers[key]) return;
    if (activeKey && activeKey !== key && layers[activeKey]) leafletMap.removeLayer(layers[activeKey]);
    if (!leafletMap.hasLayer(layers[key])) layers[key].addTo(leafletMap);
    activeKey = key;
    restyleActive();
    updateTooltips();
    if (!didFit) {
      try { leafletMap.fitBounds(layers[key].getBounds(), { padding: [10, 10] }); didFit = true; } catch (e) { /* empty */ }
    }
  }

  function restyleActive() {
    if (activeKey && layers[activeKey]) layers[activeKey].setStyle((feature) => styleFor(activeKey, feature));
    applySelection();
  }

  // Selection: highlight only the clicked feature's border (fill stays the
  // leader color). resetStyle() returns a feature to its computed styleFor.
  function applySelection() {
    if (selectedLayer) {
      selectedLayer.setStyle(SELECTED_STYLE);
      if (selectedLayer.bringToFront) selectedLayer.bringToFront();
    }
  }
  function selectFeature(layer) {
    if (selectedLayer && selectedLayer !== layer && activeKey && layers[activeKey]) {
      try { layers[activeKey].resetStyle(selectedLayer); } catch (e) { /* empty */ }
    }
    selectedLayer = layer;
    applySelection();
  }
  function clearSelection() {
    if (selectedLayer && activeKey && layers[activeKey]) {
      try { layers[activeKey].resetStyle(selectedLayer); } catch (e) { /* empty */ }
    }
    selectedLayer = null;
  }

  // Leader for a given layer feature.
  function leaderFor(key, props) {
    if (key === "precinct") return analysisByPrecinct.get(props.precinct)?.leader || null;
    if (key === "sup") return leaderInSupDistrict(props.supervisor_district);
    if (key === "cd11") {
      const sorted = [...(lastData?.candidates || [])].sort((a, b) => (b.votes || 0) - (a.votes || 0));
      return sorted[0]?.name || null;
    }
    return null;
  }

  function styleFor(key, feature) {
    const props = feature.properties || {};

    // Heat-map mode: fill by the selected candidate's vote share (sequential ramp).
    if (colorMode !== "leader") {
      const fill = heatColorFor(key, props);
      if (key === "precinct") {
        if (fill == null) return { weight: 1, color: "#2a2a2a", fillOpacity: 0.08, fillColor: "#e0e0e0" };
        return { weight: 1.4, color: "#2a2a2a", fillOpacity: 0.78, fillColor: fill };
      }
      if (key === "sup") {
        return { weight: 3, color: "#1a1a1a", fillOpacity: fill ? 0.78 : 0.08, fillColor: fill || "#bbb" };
      }
      return { weight: 3.5, color: "#111", fillOpacity: fill ? 0.7 : 0.08, fillColor: fill || "#bbb" };
    }

    // Leader mode: fill by the race leader (categorical).
    const leader = leaderFor(key, props);
    if (key === "precinct") {
      const base = { weight: 1.4, color: "#2a2a2a", fillOpacity: 0.4, fillColor: "#e0e0e0" };
      if (!analysisByPrecinct.get(props.precinct)) { base.fillOpacity = 0.08; base.weight = 1; return base; }
      base.fillColor = leaderColorMap.get(leader) || "#888";
      return base;
    }
    if (key === "sup") {
      return { weight: 3, color: "#1a1a1a", fillOpacity: leader ? 0.32 : 0.08, fillColor: leaderColorMap.get(leader) || "#bbb" };
    }
    // cd11 outline
    return { weight: 3.5, color: "#111", fillOpacity: leader ? 0.28 : 0.08, fillColor: leaderColorMap.get(leader) || "#bbb" };
  }

  function tooltipFor(key, props) {
    let title;
    if (key === "precinct") title = props.precinct_full_name || `PCT ${props.precinct}`;
    else if (key === "sup") title = `Supervisor District ${props.supervisor_district}`;
    else title = "All CD-11";

    // Heat-map mode: show the selected candidate's share for this feature.
    if (colorMode !== "leader") {
      const share = shareForFeature(key, props, colorMode);
      if (share == null) return escapeHtml(title);
      return `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(displayName(colorMode))} ${(share * 100).toFixed(1)}%`;
    }

    const leader = leaderFor(key, props);
    if (!leader) return escapeHtml(title);
    const pct = leadingPct(key, props, leader);
    return `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(leader)} ${pct.toFixed(1)}%`;
  }

  // Leading candidate's share for a feature.
  function leadingPct(key, props, leader) {
    if (key === "precinct") {
      const d = analysisByPrecinct.get(props.precinct);
      return d && d.total_votes ? ((d.candidates?.[leader] || 0) / d.total_votes) * 100 : 0;
    }
    if (key === "sup") {
      const tally = tallySupDistrict(props.supervisor_district);
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      return total ? ((tally[leader] || 0) / total) * 100 : 0;
    }
    const cw = lastData?.candidates || [];
    const total = cw.reduce((a, c) => a + (c.votes || 0), 0);
    const me = cw.find((c) => c.name === leader);
    return total && me ? (me.votes / total) * 100 : 0;
  }

  // ---- candidate heat-map coloring ------------------------------------------
  // "Where is this candidate's vote share coming from" — a sequential plasma
  // ramp (dark = low share, yellow = high). Each candidate is normalized to its
  // OWN observed precinct-share range, because their ranges differ a lot
  // (Wiener ~20-67%, Saikat ~3-30%); a shared scale would wash Saikat out.
  // The exact % is always shown in the tooltip and the click panel.
  const PLASMA = [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]];
  function plasma(t) {
    t = Math.max(0, Math.min(1, t));
    const x = t * (PLASMA.length - 1), i = Math.floor(x), f = x - i;
    const a = PLASMA[i], b = PLASMA[Math.min(i + 1, PLASMA.length - 1)];
    const m = (j) => Math.round(a[j] + (b[j] - a[j]) * f);
    return `rgb(${m(0)},${m(1)},${m(2)})`;
  }
  function computeHeatDomains(data) {
    heatDomain = {};
    // Aggregate precinct votes up to supervisor districts so the SD heat map gets
    // its own (narrower) min/max and still spans the full color ramp.
    const sd = {};  // sd -> { total, byCand:{} }
    for (const p of data.precincts || []) {
      const k = precinctToSD.get(p.precinct);
      if (k == null) continue;
      const key = String(k);
      sd[key] = sd[key] || { total: 0, byCand: {} };
      for (const [c, v] of Object.entries(p.candidates || {})) {
        sd[key].byCand[c] = (sd[key].byCand[c] || 0) + v;
        sd[key].total += v;
      }
    }
    for (const n of HEAT_NAMES) {
      let pmn = Infinity, pmx = -Infinity;
      for (const p of data.precincts || []) {
        const t = p.total_votes || 0;
        if (!t) continue;
        const s = (p.candidates?.[n] || 0) / t;
        if (s < pmn) pmn = s;
        if (s > pmx) pmx = s;
      }
      let smn = Infinity, smx = -Infinity;
      for (const key of Object.keys(sd)) {
        const t = sd[key].total;
        if (!t) continue;
        const s = (sd[key].byCand[n] || 0) / t;
        if (s < smn) smn = s;
        if (s > smx) smx = s;
      }
      heatDomain[n] = {
        precinct: pmn === Infinity ? { min: 0, max: 1 } : { min: pmn, max: pmx },
        sup: smn === Infinity ? { min: 0, max: 1 } : { min: smn, max: smx },
      };
    }
  }
  function shareForFeature(key, props, name) {
    if (key === "precinct") {
      const d = analysisByPrecinct.get(props.precinct);
      return d && d.total_votes ? (d.candidates?.[name] || 0) / d.total_votes : null;
    }
    if (key === "sup") {
      const tally = tallySupDistrict(props.supervisor_district);
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      return total ? (tally[name] || 0) / total : null;
    }
    const cw = lastData?.candidates || [];
    const total = cw.reduce((a, c) => a + (c.votes || 0), 0);
    const me = cw.find((c) => c.name === name);
    return total && me ? me.votes / total : null;
  }
  function heatColorFor(key, props) {
    const share = shareForFeature(key, props, colorMode);
    if (share == null) return null;
    const dom = heatDomainFor(colorMode, key);
    const t = dom.max > dom.min ? (share - dom.min) / (dom.max - dom.min) : 0.5;
    return plasma(t);
  }
  function heatDomainFor(name, key) {
    const d = heatDomain[name];
    if (!d) return { min: 0, max: 1 };
    return key === "sup" ? d.sup : d.precinct;
  }
  function displayName(n) {
    return String(n).split(/\s+/).map((w) => (w ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
  }

  function updateTooltips() {
    if (!activeKey || !layers[activeKey]) return;
    layers[activeKey].eachLayer((layer) => {
      const props = layer.feature?.properties || {};
      layer.setTooltipContent(tooltipFor(activeKey, props));
    });
  }

  // ---- supervisor-district aggregation (reads SD from the precinct GeoJSON) --

  function tallySupDistrict(sd) {
    const tally = {};
    if (sd == null || !lastData?.precincts) return tally;
    for (const p of lastData.precincts) {
      if (String(precinctToSD.get(p.precinct)) !== String(sd)) continue;
      for (const [cand, votes] of Object.entries(p.candidates || {})) {
        tally[cand] = (tally[cand] || 0) + votes;
      }
    }
    return tally;
  }

  function leaderInSupDistrict(sd) {
    const tally = tallySupDistrict(sd);
    let best = null, bestVotes = -1;
    for (const [c, v] of Object.entries(tally)) if (v > bestVotes) { best = c; bestVotes = v; }
    return best;
  }

  // ---- side panels ----------------------------------------------------------

  function candidateRows(candObj, total) {
    const sorted = Object.entries(candObj || {}).sort(([, a], [, b]) => b - a);
    return pickDisplay(sorted).map(([name, votes]) => {
      const pct = total ? (votes / total) * 100 : 0;
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
  }

  function panelFooter() {
    const certified = lastData?.certified ? "Certified final." : "Preliminary until certified.";
    return `<p style="font-size:0.8rem;color:var(--color-muted);margin-top:1rem">Updated ${formatTimestamp(lastData?.timestamp)}. ${certified}</p>`;
  }

  function panelHeader(total) {
    return `<p style="font-size:0.85rem;color:var(--color-muted);margin:0.5rem 0">Total ballots counted: <strong>${total.toLocaleString()}</strong></p>`;
  }

  function openPanel(key, props) {
    if (key === "sup") return openSupPanel(props.supervisor_district);
    if (key === "cd11") return openCitywidePanel();
    return openPrecinctPanel(props);
  }

  function openPrecinctPanel(props) {
    const data = analysisByPrecinct.get(props.precinct);
    els.detailTitle.textContent = props.precinct_full_name || `PCT ${props.precinct}`;
    if (!data) {
      els.detailBody.innerHTML = `<p class="placeholder">No data yet for this precinct.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    const total = data.total_votes || 1;
    const nb = props.neighborhood
      ? `<p style="font-size:0.8rem;color:var(--color-muted);margin:0 0 0.25rem">${escapeHtml(props.neighborhood)}</p>`
      : "";
    els.detailBody.innerHTML = `${nb}${panelHeader(total)}${candidateRows(data.candidates, total)}${panelFooter()}`;
    els.detail.classList.remove("hidden");
  }

  function openSupPanel(sd) {
    const tally = tallySupDistrict(sd);
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    els.detailTitle.textContent = sd != null ? `Supervisor District ${sd}` : "Supervisor district";
    if (!total) {
      els.detailBody.innerHTML = `<p class="placeholder">No data yet for this district.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    els.detailBody.innerHTML = `${panelHeader(total)}${candidateRows(tally, total)}${panelFooter()}`;
    els.detail.classList.remove("hidden");
  }

  function openCitywidePanel() {
    const tally = {};
    for (const c of lastData?.candidates || []) tally[c.name] = c.votes || 0;
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    els.detailTitle.textContent = "All CD-11 — Citywide";
    if (!total) {
      els.detailBody.innerHTML = `<p class="placeholder">No results yet.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    els.detailBody.innerHTML = `${panelHeader(total)}${candidateRows(tally, total)}${panelFooter()}`;
    els.detail.classList.remove("hidden");
  }

  // ---- legend ---------------------------------------------------------------

  function renderLegend() {
    if (!leafletMap) return;
    if (legendControl) { legendControl.remove(); legendControl = null; }

    // Heat-map mode: gradient legend spanning the candidate's actual share range.
    if (colorMode !== "leader") {
      if (!heatDomain[colorMode]) return;
      const dom = heatDomainFor(colorMode, granularity);
      legendControl = L.control({ position: "bottomright" });
      legendControl.onAdd = () => {
        const div = L.DomUtil.create("div", "legend");
        const grad = `linear-gradient(to right, ${plasma(0)}, ${plasma(0.25)}, ${plasma(0.5)}, ${plasma(0.75)}, ${plasma(1)})`;
        div.innerHTML = `<strong>${escapeHtml(displayName(colorMode))} &mdash; vote share</strong>` +
          `<div class="legend-gradient" style="background:${grad}"></div>` +
          `<div class="legend-scale"><span>${(dom.min * 100).toFixed(0)}%</span><span>${(dom.max * 100).toFixed(0)}%</span></div>`;
        return div;
      };
      legendControl.addTo(leafletMap);
      return;
    }

    // Leader mode: categorical swatches.
    if (!leaderColorMap.size) return;
    const sorted = [...(lastData?.candidates || [])].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    const shown = pickDisplay(sorted.map((c) => [c.name, c.votes || 0]));
    if (!shown.length) return;
    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
      const div = L.DomUtil.create("div", "legend");
      div.innerHTML = `<strong>Race leader</strong>` + shown.map(([n]) =>
        `<div class="legend-row"><span class="legend-swatch" style="background:${leaderColorMap.get(n)}"></span> ${escapeHtml(n)}</div>`
      ).join("");
      return div;
    };
    legendControl.addTo(leafletMap);
  }

  // ---- small helpers --------------------------------------------------------

  function initials(name) {
    return name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("");
  }

  function lookupCandidate(name) {
    if (!candidates || !name) return {};
    const upper = name.toUpperCase().trim();
    if (candidates[upper]) return candidates[upper];
    const tokens = upper.split(/[\s,]+/).filter(Boolean);
    for (const tok of tokens) if (candidates[tok]) return candidates[tok];
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

// CD-11 public results map — v0 skeleton.
// Loads ./data/latest.json on a 60s timer and renders the precinct/SD-11/CD-11 view.
// Real map implementation comes after the first Report 4 drop on June 2.

(() => {
  const REFRESH_MS = 60 * 1000;
  const DATA_URL = "./data/latest.json";

  const els = {
    lastUpdate: document.getElementById("last-update"),
    ballotsCounted: document.getElementById("ballots-counted"),
    citywideStrip: document.getElementById("citywide-strip"),
    map: document.getElementById("results-map"),
    statusBanner: document.getElementById("status-banner"),
    toggleButtons: document.querySelectorAll(".map-toggle button"),
  };

  let granularity = "precinct";

  els.toggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.toggleButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      granularity = btn.dataset.granularity;
      renderMap();
    });
  });

  async function tick() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      render(data);
    } catch (err) {
      console.warn("[public-map] no data yet:", err.message);
    }
  }

  function render(data) {
    els.lastUpdate.textContent = `Last update: ${data.timestamp || "—"}`;
    els.ballotsCounted.textContent = `Ballots counted: ${data.progress?.counted?.toLocaleString() || "—"}`;
    if (data.certified) {
      els.statusBanner.textContent = "CERTIFIED FINAL";
      els.statusBanner.classList.add("certified");
    }
    renderCitywide(data.citywide || []);
    renderMap(data);
  }

  function renderCitywide(candidates) {
    if (!candidates.length) return;
    els.citywideStrip.innerHTML = `
      <strong>Citywide preliminary:</strong>
      ${candidates.map((c) => `${c.name} ${(c.share * 100).toFixed(1)}%`).join(" • ")}
    `;
  }

  function renderMap(data) {
    // TODO: Leaflet choropleth, race-leader coloring, click-to-open side panel.
    // For now, this is a placeholder until precinct GeoJSON + leader data lands at Report 4.
    if (!data || !data.precincts) {
      els.map.innerHTML = `<div class="placeholder">Precinct-level data expected with Report 4 (approximately midnight).</div>`;
      return;
    }
    els.map.innerHTML = `<div class="placeholder">Map (${granularity} view) wired post Report 4. ${data.precincts.length} precincts loaded.</div>`;
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();

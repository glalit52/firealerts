/* Firealerts web console. Plain JS + MapLibre, no build step. */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const DANGER = {
    very_low: ["Very low", "#3ecf8e"],
    low: ["Low", "#9be15d"],
    moderate: ["Moderate", "#ffd84d"],
    high: ["High", "#ff9a3c"],
    very_high: ["Very high", "#ff4d4d"],
    extreme: ["Extreme", "#a1124a"],
  };
  const HORIZON = { 1: "#fff3b0", 3: "#ffd166", 6: "#ff9f43", 12: "#ff6a2b", 24: "#e0244a", 48: "#a1124a", 72: "#6a0d47" };
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

  const state = {
    hours: 24,
    incidents: [],
    selected: null,
    picking: null, // "aoi" | "whatif" | null
    danger: null,
    fuels: [],
    lastForecast: null,
  };

  // ------------------------------------------------------------------ API
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  };

  async function api(path, opts = {}) {
    const headers = { "content-type": "application/json" };
    const token = store.get("fa_token");
    if (token) headers.authorization = `Bearer ${token}`;
    const org = store.get("fa_org");
    if (org && token) headers["x-org-id"] = org;
    const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      if (token) { store.set("fa_token", null); store.set("fa_org", null); }
      if (state.me?.auth_required !== false) showAuth("login");
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch (_) { /* not json */ }
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return res.status === 204 ? null : res.json();
  }

  function toast(msg, ms = 3500) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  // ------------------------------------------------------------------ map
  const empty = { type: "FeatureCollection", features: [] };
  const hash = location.hash.includes("invite=") ? [] : location.hash.slice(1).split(",").map(Number);
  const map = new maplibregl.Map({
    container: "map",
    center: hash.length === 3 && hash.every(Number.isFinite) ? [hash[1], hash[0]] : [-30, 5],
    zoom: hash.length === 3 && hash.every(Number.isFinite) ? hash[2] : 1.6,
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        dark: {
          type: "raster",
          tiles: ["a", "b", "c"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`),
          tileSize: 256,
          attribution: "© OpenStreetMap contributors © CARTO",
        },
        sat: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          maxzoom: 18,
          attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
        },
        labels: {
          type: "raster",
          tiles: ["a", "b", "c"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png`),
          tileSize: 256,
        },
      },
      layers: [
        { id: "dark", type: "raster", source: "dark" },
        { id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } },
        { id: "labels", type: "raster", source: "labels", layout: { visibility: "none" } },
      ],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

  map.on("moveend", () => {
    const c = map.getCenter();
    history.replaceState(null, "", `#${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom().toFixed(1)}`);
  });

  map.on("load", () => {
    const src = (id) => map.addSource(id, { type: "geojson", data: empty });
    ["danger", "burn", "perims", "seed", "hulls", "aois", "dets", "whatif-pt"].forEach(src);

    map.addLayer({
      id: "danger-fill", type: "fill", source: "danger",
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.38, "fill-antialias": false },
    });
    map.addLayer({
      id: "burn-fill", type: "fill", source: "burn",
      paint: {
        "fill-color": ["interpolate", ["linear"], ["get", "p"], 0, "#ffd166", 0.5, "#ff6a2b", 1, "#b3003c"],
        "fill-opacity": ["interpolate", ["linear"], ["get", "p"], 0, 0.08, 1, 0.55],
        "fill-antialias": false,
      },
      layout: { visibility: "none" },
    });
    map.addLayer({
      id: "perims-p90", type: "line", source: "perims", filter: ["==", ["get", "kind"], "p90"],
      paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.9 },
    });
    map.addLayer({
      id: "perims-fill", type: "fill", source: "perims", filter: ["==", ["get", "kind"], "likely"],
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.12 },
    });
    map.addLayer({
      id: "perims-line", type: "line", source: "perims", filter: ["==", ["get", "kind"], "likely"],
      paint: { "line-color": ["get", "color"], "line-width": 2 },
      layout: { "line-cap": "round", "line-join": "round" },
    });
    map.addLayer({ id: "seed", type: "fill", source: "seed", paint: { "fill-color": "#ff3b3b", "fill-opacity": 0.5 } });
    map.addLayer({ id: "seed-line", type: "line", source: "seed", paint: { "line-color": "#ff3b3b", "line-width": 2.5 }, layout: { "line-cap": "round" } });
    map.addLayer({
      id: "hulls", type: "line", source: "hulls",
      paint: { "line-color": "#ff8a4c", "line-width": ["case", ["boolean", ["get", "sel"], false], 2.5, 1], "line-opacity": 0.7 },
      minzoom: 6,
    });
    map.addLayer({ id: "aois-fill", type: "fill", source: "aois", paint: { "fill-color": "#5aa9ff", "fill-opacity": 0.06 } });
    map.addLayer({ id: "aois-line", type: "line", source: "aois", paint: { "line-color": "#5aa9ff", "line-width": 1.5, "line-dasharray": [3, 2] } });
    map.addLayer({
      id: "dets-heat", type: "heatmap", source: "dets", maxzoom: 7,
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 5], 0, 0.2, 100, 1],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 7, 2],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 7, 18],
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "#7a1f2b", 0.45, "#e0442a", 0.7, "#ff9f43", 1, "#fff3b0"],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.9, 7, 0],
      },
    });
    map.addLayer({
      id: "dets", type: "circle", source: "dets", minzoom: 4.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 5], 0, 1.5, 200, 5], 12, ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 5], 0, 4, 200, 11]],
        "circle-color": ["step", ["get", "age_h"], "#fff3b0", 1, "#ffb02b", 6, "#ff6a2b", 12, "#b3263b"],
        "circle-stroke-color": ["match", ["get", "kind"], "geo", "#ffffff", "rgba(0,0,0,0.6)"],
        "circle-stroke-width": ["match", ["get", "kind"], "geo", 1, 0.5],
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 0, 5.5, 0.95],
        "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 0, 5.5, 1],
      },
    });
    map.addLayer({ id: "whatif-pt", type: "circle", source: "whatif-pt", paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": "#ff3b3b", "circle-stroke-width": 3 } });

    map.on("click", "dets", (e) => {
      if (state.picking) return;
      const p = e.features[0].properties;
      new maplibregl.Popup({ offset: 8 })
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${esc(p.source)}</b> ${esc(p.satellite)}<br>${new Date(p.acq_time).toLocaleString()}<br>` +
          `FRP <b>${fmt(p.frp, 1)}</b> MW · conf. ${esc({ l: "low", n: "nominal", h: "high" }[p.confidence])}<br>` +
          `<span class="mono">${(+e.features[0].geometry.coordinates[1]).toFixed(4)}, ${(+e.features[0].geometry.coordinates[0]).toFixed(4)}</span>`
        )
        .addTo(map);
      e.preventDefault();
    });
    map.on("click", "hulls", (e) => {
      if (state.picking || e.defaultPrevented) return;
      selectIncident(e.features[0].properties.id);
      e.preventDefault();
    });
    ["dets", "hulls"].forEach((l) => {
      map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
    });
    map.on("click", onMapClick);

    boot();
  });

  async function onMapClick(e) {
    if (e.defaultPrevented) return;
    const { lat, lng } = e.lngLat;
    if (state.picking === "aoi") {
      $("#aoi-form [name=center]").value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      setPicking(null);
      return;
    }
    if (state.picking === "whatif") {
      setPicking(null);
      map.getSource("whatif-pt").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] } }] });
      openForecast({ kind: "whatif", lat, lon: lng });
      return;
    }
    if ($("#tab-danger").classList.contains("on")) pointDanger(lat, lng);
  }

  function setPicking(mode) {
    state.picking = mode;
    document.body.classList.toggle("picking", !!mode);
    $("#whatif").classList.toggle("active", mode === "whatif");
    $("#pick-center").classList.toggle("active", mode === "aoi");
    if (mode === "whatif") toast("Click the map where a fire could start");
    if (mode === "aoi") toast("Click the map to set the centre of the area");
  }

  // ------------------------------------------------------------------ status
  async function loadStatus() {
    const s = await api("/api/status");
    const pill = $("#mode-pill");
    const mode = s.active_mode || s.data_mode;
    pill.textContent = mode === "live" ? "LIVE" : mode === "demo" ? "DEMO DATA" : mode.toUpperCase();
    pill.className = `pill ${mode === "live" ? "live" : "demo"}`;
    pill.title = mode === "demo" ? "Satellite feeds unreachable or DATA_MODE=demo: showing synthetic fires" : "Live satellite feeds";
    const groups = { VIIRS: 0, MODIS: 0, GEO: 0, OTHER: 0 };
    for (const [k, v] of Object.entries(s.by_source_24h)) {
      const g = k.startsWith("VIIRS") ? "VIIRS" : k.startsWith("MODIS") ? "MODIS" : isGeo(k) ? "GEO" : "OTHER";
      groups[g] += v;
    }
    const latest = s.latest_detection ? timeAgo(new Date(s.latest_detection)) : "–";
    const lastRun = s.runs[0]?.finished_at ? timeAgo(new Date(s.runs[0].finished_at)) : "never";
    $("#sensor-stats").innerHTML =
      stat(fmt(s.detections_24h), "Detections 24 h") +
      stat(fmt(groups.VIIRS), "VIIRS 375 m") +
      stat(fmt(groups.MODIS), "MODIS 1 km") +
      stat(fmt(groups.GEO), "Geostationary") +
      stat(latest, "Latest pixel") +
      stat(lastRun, "Last sync");
  }
  const isGeo = (src) => /^(GOES|HIMAWARI|METEOSAT)/.test(src);
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  function timeAgo(d) {
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  // ------------------------------------------------------------------ detections & incidents
  async function loadDetections() {
    const fc = await api(`/api/detections?hours=${state.hours}`);
    const now = Date.now();
    for (const f of fc.features) {
      f.properties.age_h = (now - new Date(f.properties.acq_time).getTime()) / 3.6e6;
      f.properties.kind = isGeo(f.properties.source) ? "geo" : "polar";
    }
    map.getSource("dets").setData(fc);
  }

  async function loadIncidents() {
    const minCount = Math.max(1, +$("#min-count").value || 1);
    const res = await api(`/api/incidents?hours=${state.hours}&min_count=${minCount}&limit=1000`);
    state.incidents = res.incidents;
    renderHulls();
    renderIncidents();
  }

  function renderHulls() {
    map.getSource("hulls").setData({
      type: "FeatureCollection",
      features: state.incidents.filter((i) => i.hull).map((i) => ({ type: "Feature", geometry: i.hull, properties: { id: i.id, sel: i.id === state.selected } })),
    });
  }

  function prioColor(p) {
    if (p >= 80) return ["#ff4d5e", "rgba(255,77,94,.15)"];
    if (p >= 60) return ["#ff9a3c", "rgba(255,154,60,.15)"];
    if (p >= 40) return ["#ffd84d", "rgba(255,216,77,.12)"];
    return ["#8b93a7", "rgba(139,147,167,.12)"];
  }

  function renderIncidents() {
    const q = $("#inc-filter").value.trim().toLowerCase();
    const items = state.incidents.filter((i) => !q || i.sources.join(" ").toLowerCase().includes(q) || `${i.lat}, ${i.lon}`.includes(q));
    $("#inc-summary").textContent = `${items.length} incident${items.length === 1 ? "" : "s"} · ${items.filter((i) => i.status === "active").length} active · sorted by priority`;
    $("#incident-list").innerHTML = items
      .slice(0, 300)
      .map((i) => {
        const [c, bg] = prioColor(i.priority);
        const tags = i.sources.map((s) => `<span class="tag ${isGeo(s) ? "geo" : ""}">${esc(s.replace("VIIRS_", ""))}</span>`).join("");
        return `<li class="inc ${i.id === state.selected ? "sel" : ""}" data-id="${i.id}">
          <div class="prio" style="color:${c};background:${bg}">${i.priority}</div>
          <div><div class="inc-title">${i.lat.toFixed(3)}, ${i.lon.toFixed(3)}</div>
            <div class="inc-meta">${i.count} px · ${fmt(i.area_ha)} ha · ${i.status === "active" ? "seen " + timeAgo(new Date(i.last_seen)) : "cooling"}</div>
            <div>${tags}</div></div>
          <div class="inc-right"><b>${fmt(i.frp_sum)}</b><br>MW FRP</div>
        </li>`;
      })
      .join("") || `<li class="muted small">No incidents in this window.</li>`;
  }

  $("#incident-list").addEventListener("click", (e) => {
    const li = e.target.closest(".inc");
    if (li) selectIncident(li.dataset.id);
  });
  $("#inc-filter").addEventListener("input", renderIncidents);
  $("#min-count").addEventListener("change", loadIncidents);

  function selectIncident(id) {
    const inc = state.incidents.find((i) => i.id === id);
    if (!inc) return;
    state.selected = id;
    renderIncidents();
    renderHulls();
    map.flyTo({ center: [inc.lon, inc.lat], zoom: Math.max(map.getZoom(), 10), speed: 1.6 });
    openForecast({ kind: "incident", inc });
  }

  // ------------------------------------------------------------------ forecast drawer
  const IMAGE_LAYERS = { arrival: 0.85, burn: 0.9, fuel: 0.75 };

  function setForecastImages(images) {
    for (const [name, opacity] of Object.entries(IMAGE_LAYERS)) {
      const id = `img-${name}`;
      if (!images) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
        continue;
      }
      const spec = { url: images[name], coordinates: images.coordinates };
      if (map.getSource(id)) map.getSource(id).updateImage(spec);
      else {
        map.addSource(id, { type: "image", ...spec });
        map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": opacity, "raster-resampling": "nearest", "raster-fade-duration": 0 }, layout: { visibility: "none" } }, "perims-p90");
      }
    }
  }

  function showImage(name, on) {
    if (map.getLayer(`img-${name}`)) map.setLayoutProperty(`img-${name}`, "visibility", on ? "visible" : "none");
  }

  function clearForecast() {
    ["perims", "seed", "burn", "whatif-pt"].forEach((s) => map.getSource(s).setData(empty));
    setForecastImages(null);
  }

  $("#drawer-close").addEventListener("click", () => {
    $("#drawer").hidden = true;
    state.selected = null;
    clearForecast();
    renderIncidents();
    renderHulls();
  });

  async function openForecast(target, opts = {}) {
    const drawer = $("#drawer");
    drawer.hidden = false;
    const body = $("#drawer-body");
    const fuel = opts.fuel || "auto";
    const curing = opts.curing ?? 85;
    const hours = opts.hours || 24;
    const model = opts.model || "auto";
    const title = target.kind === "incident" ? "Fire incident" : "What-if ignition";
    const lat = target.kind === "incident" ? target.inc.lat : target.lat;
    const lon = target.kind === "incident" ? target.inc.lon : target.lon;
    body.innerHTML = `<h2>${title}</h2><div class="muted mono small">${lat.toFixed(4)}, ${lon.toFixed(4)} <span id="place"></span></div><div class="loading">Running ${hours} h ${model === "uniform" ? "" : "terrain-aware "}ensemble spread forecast</div>`;
    reverseGeocode(lat, lon);

    const qs = `fuel=${encodeURIComponent(fuel)}&curing=${curing}&hours=${hours}&model=${model}`;
    let fc;
    try {
      fc = target.kind === "incident" ? await api(`/api/incidents/${target.inc.id}/forecast?${qs}`) : await api(`/api/forecast/spread?lat=${lat}&lon=${lon}&${qs}`);
    } catch (err) {
      body.innerHTML += `<p class="muted">Forecast failed: ${esc(err.message)}</p>`;
      return;
    }
    state.lastForecast = { target, fc };
    drawForecast(fc);

    const inc = target.kind === "incident" ? fc.incident : null;
    const cur = fc.current;
    const today = fc.danger.find((d) => d.forecast) || fc.danger[fc.danger.length - 1];
    const last = fc.stats[fc.stats.length - 1];
    const maxHfi = Math.max(...fc.hourly.map((h) => h.intensity_kw_m));
    const raster = fc.model === "raster";
    const hasGrass = raster ? Object.keys(fc.fuel_mix || {}).some((c) => c.startsWith("O1")) : fc.fuel.code.startsWith("O1");
    const fuelOpts = [`<option value="auto">${raster ? "Land cover" : `Auto (${fc.fuel.code})`}</option>`]
      .concat(state.fuels.map((f) => `<option value="${f.code}" ${f.code === fuel ? "selected" : ""}>${f.code} · ${esc(f.name)}</option>`))
      .join("");

    body.innerHTML = `
      <h2>${title}</h2>
      <div class="muted mono small">${lat.toFixed(4)}, ${lon.toFixed(4)} <span id="place"></span></div>
      ${inc ? `<div class="small muted">First seen ${new Date(inc.first_seen).toLocaleString()} · last ${timeAgo(new Date(inc.last_seen))} · ${inc.sources.map(esc).join(", ")}</div>` : ""}
      <div class="tiles">
        ${inc ? tile(inc.priority, "Priority") + tile(inc.count, "Fire pixels") + tile(fmt(inc.frp_sum), "FRP MW") : ""}
        ${tile(fmt(fc.seed.properties.area_ha), "Area now ha")}
        ${tile(fmt(last.area_ha_p50), `P50 +${last.horizon_h} h ha`)}
        ${tile(fmt(maxHfi / 1000, 1), "Peak HFI MW/m")}
      </div>
      <h3>Weather now</h3>
      <div class="tiles">
        ${tile(`${fmt(cur.temp, 1)}°`, "Temp")}
        ${tile(`${fmt(cur.rh)}%`, "Rel. humidity")}
        ${tile(`${fmt(cur.wind)} <small>${compass(cur.wind_dir)}</small>`, "Wind km/h")}
        ${tile(fmt(cur.ffmc, 1), "FFMC")}
        ${tile(fmt(cur.isi, 1), "ISI")}
        ${tile(`<span style="color:${DANGER[today.danger][1]}">${fmt(today.fwi, 0)}</span>`, `FWI · ${DANGER[today.danger][0]}`)}
      </div>
      <h3>Spread forecast · ${fc.members}-member ensemble <span class="tag ${raster ? "geo" : ""}">${raster ? `terrain-aware · ${fc.terrain.cell_m} m` : "uniform fuel"}</span></h3>
      ${fc.model_note ? `<div class="note">${esc(fc.model_note)}</div>` : ""}
      <div class="form-row three">
        <label>Fuel <select id="f-fuel">${fuelOpts}</select></label>
        <label>Model <select id="f-model">${[["auto", "Auto"], ["raster", "Terrain"], ["uniform", "Uniform"]].map(([v, l]) => `<option value="${v}" ${v === model ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Horizon <select id="f-hours">${[12, 24, 48, 72].map((h) => `<option ${h === hours ? "selected" : ""} value="${h}">${h} h</option>`).join("")}</select></label>
        <button class="btn primary" id="f-run">Re-run</button>
      </div>
      <label class="ctl" id="curing-row" ${hasGrass ? "" : "hidden"}>Grass curing <input type="range" id="f-curing" min="0" max="100" value="${curing}" /> <span class="mono" id="curing-v">${curing}%</span></label>
      <table class="horizons">
        <thead><tr><th>Horizon</th><th>Local time</th><th>P10 ha</th><th>P50 ha</th><th>P90 ha</th><th>Run km</th></tr></thead>
        <tbody>${fc.stats.map((s) => `<tr><td><span class="swatch" style="background:${HORIZON[s.horizon_h]}"></span>+${s.horizon_h} h</td><td>${new Date(s.time).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</td><td>${fmt(s.area_ha_p10)}</td><td><b>${fmt(s.area_ha_p50)}</b></td><td>${fmt(s.area_ha_p90)}</td><td>${fmt(s.max_run_km, 1)}</td></tr>`).join("")}</tbody>
      </table>
      <label class="check"><input type="checkbox" id="show-p90" checked /> P90 envelope (dashed)</label>
      <label class="check"><input type="checkbox" id="show-burn" /> Burn probability at +${last.horizon_h} h</label>
      ${raster ? `<label class="check"><input type="checkbox" id="show-arrival" checked /> Arrival time (P50)</label>
      <label class="check"><input type="checkbox" id="show-fuel" /> Fuel map</label>
      <h3>Terrain &amp; fuels</h3>
      <div class="tiles">
        ${tile(`${fmt(fc.terrain.elevation_m[0])}–${fmt(fc.terrain.elevation_m[1])}`, "Elevation m")}
        ${tile(`${fmt(fc.terrain.slope_pct_p90)}%`, "Slope P90")}
        ${tile(`${fmt(fc.terrain.size_km)} km`, "Domain")}
      </div>
      ${fuelBar(fc.fuel_mix)}
      <div class="muted small">${esc(fc.terrain.source)}${fc.domain_limited ? " · <b>fire reaches the domain edge: areas are a lower bound</b>" : ""}</div>` : ""}
      <h3>Hourly behaviour</h3>
      ${chart(fc.hourly)}
      <h3>Fire danger outlook</h3>
      ${dangerStrip(fc.danger)}
      <div class="note">
        Fuel <b>${esc(fc.fuel.code)}</b> (${esc(fc.fuel.name)}). Moisture codes FFMC ${fc.fwi_state.ffmc} · DMC ${fc.fwi_state.dmc} · DC ${fc.fwi_state.dc} · BUI ${fc.fwi_state.bui}.
        Weather: ${fc.weather_source === "demo" ? "synthetic (offline)" : "Open-Meteo"}.
        ${raster
          ? "Canadian FBP rate of spread per cell with slope-equivalent wind, fuel from ESA WorldCover, non-fuel cells as barriers, arrival time by ordered-upwind minimum travel time."
          : "Canadian FBP rate of spread with exact Huygens elliptical growth over a single fuel; terrain and barriers are ignored."}
        Ensemble perturbs wind speed, direction and ROS. Suppression is not modelled — treat as decision support, not ground truth.
      </div>`;

    $("#f-run").onclick = () => openForecast(target, { fuel: $("#f-fuel").value, model: $("#f-model").value, hours: +$("#f-hours").value, curing: +($("#f-curing")?.value ?? 85) });
    $("#f-curing").oninput = (e) => ($("#curing-v").textContent = `${e.target.value}%`);
    $("#show-p90").onchange = (e) => map.setLayoutProperty("perims-p90", "visibility", e.target.checked ? "visible" : "none");
    $("#show-burn").onchange = (e) => (raster ? showImage("burn", e.target.checked) : map.setLayoutProperty("burn-fill", "visibility", e.target.checked ? "visible" : "none"));
    map.setLayoutProperty("perims-p90", "visibility", "visible");
    map.setLayoutProperty("burn-fill", "visibility", "none");
    if (raster) {
      $("#show-arrival").onchange = (e) => showImage("arrival", e.target.checked);
      $("#show-fuel").onchange = (e) => showImage("fuel", e.target.checked);
      showImage("arrival", true);
    }
    reverseGeocode(lat, lon);
  }

  const tile = (v, l) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`;

  const FUEL_COLORS = { C1: "#5e8c5a", C2: "#225a32", C3: "#2e6e3c", C4: "#3c7846", C5: "#508250", C6: "#467d4b", C7: "#6e8c46", D1: "#82aa5a", S1: "#be9646", O1a: "#e1d26e", O1b: "#f0be5a", "non-fuel": "#283c78" };
  function fuelBar(mix) {
    const entries = Object.entries(mix || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const name = (c) => (state.fuels.find((f) => f.code === c) || { name: c === "non-fuel" ? "Water, built-up, bare" : c }).name;
    return `<div class="fuelbar">${entries.map(([c, v]) => `<i style="width:${v}%;background:${FUEL_COLORS[c] || "#888"}" title="${esc(c)} ${v}%"></i>`).join("")}</div>
      <div class="legend">${entries.map(([c, v]) => `<span><i style="background:${FUEL_COLORS[c] || "#888"}"></i>${esc(c)} ${esc(name(c))} ${fmt(v)}%</span>`).join("")}</div>`;
  }

  function flatCoords(geom, out = []) {
    const walk = (a) => (typeof a[0] === "number" ? out.push(a) : a.forEach(walk));
    walk(geom.coordinates);
    return out;
  }

  function drawForecast(fc) {
    const feats = fc.perimeters.features
      .map((f) => ({ ...f, properties: { ...f.properties, color: HORIZON[f.properties.horizon_h] || "#ff6a2b" } }))
      .sort((a, b) => b.properties.horizon_h - a.properties.horizon_h);
    map.getSource("perims").setData({ type: "FeatureCollection", features: feats });
    map.getSource("seed").setData({ type: "FeatureCollection", features: [fc.seed] });
    map.getSource("burn").setData(fc.burn_probability);
    setForecastImages(fc.images || null);
    const outer = feats.find((f) => f.properties.kind === "p90");
    const pts = outer ? flatCoords(outer.geometry) : [];
    if (pts.length) {
      const b = new maplibregl.LngLatBounds();
      pts.forEach((c) => b.extend(c));
      map.fitBounds(b, { padding: { top: 60, bottom: 60, left: 60, right: 480 }, maxZoom: 13, duration: 900 });
    }
  }

  function chart(hourly) {
    const W = 380, H = 130, P = { l: 30, r: 30, t: 10, b: 18 };
    const n = hourly.length;
    const maxRos = Math.max(1, ...hourly.map((h) => h.ros_m_min));
    const maxWind = Math.max(10, ...hourly.map((h) => h.wind));
    const x = (i) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r);
    const yR = (v) => H - P.b - (v / maxRos) * (H - P.t - P.b);
    const yW = (v) => H - P.b - (v / maxWind) * (H - P.t - P.b);
    const bw = Math.max(1, (W - P.l - P.r) / n - 1);
    const bars = hourly.map((h, i) => `<rect x="${x(i) - bw / 2}" y="${yW(h.wind)}" width="${bw}" height="${H - P.b - yW(h.wind)}" fill="#2b3446"><title>${h.wind} km/h ${compass(h.wind_dir)}</title></rect>`).join("");
    const line = hourly.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yR(h.ros_m_min).toFixed(1)}`).join("");
    const rh = hourly.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(H - P.b - (h.rh / 100) * (H - P.t - P.b)).toFixed(1)}`).join("");
    const ticks = hourly.map((h, i) => (i % 6 === 0 ? `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${new Date(h.time).toLocaleTimeString([], { hour: "2-digit" })}</text>` : "")).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Hourly rate of spread, wind and humidity">
      ${bars}
      <path d="${rh}" fill="none" stroke="#5aa9ff" stroke-width="1.2" stroke-dasharray="3 2" />
      <path d="${line}" fill="none" stroke="#ff6a2b" stroke-width="2" />
      <text x="2" y="${P.t + 8}" fill="#ff6a2b">${fmt(maxRos, 0)}</text><text x="2" y="${P.t + 18}">m/min</text>
      <text x="${W - 2}" y="${P.t + 8}" text-anchor="end">${fmt(maxWind, 0)}</text><text x="${W - 2}" y="${P.t + 18}" text-anchor="end">km/h</text>
      ${ticks}
    </svg>
    <div class="legend"><span><i style="background:#ff6a2b"></i>Head ROS</span><span><i style="background:#2b3446"></i>Wind</span><span><i style="background:#5aa9ff"></i>Rel. humidity</span></div>`;
  }

  function dangerStrip(days) {
    const show = days.slice(-10);
    return `<div class="danger-strip">${show
      .map((d) => {
        const dt = new Date(d.date + "T12:00:00");
        return `<div class="${d.forecast ? "" : "past"}" style="background:${DANGER[d.danger][1]}" title="${DANGER[d.danger][0]} · FWI ${d.fwi} · ${d.temp}° ${d.rh}% ${d.wind} km/h · ${d.rain} mm">
          ${dt.toLocaleDateString([], { weekday: "short" })}<small>${fmt(d.fwi)}</small></div>`;
      })
      .join("")}</div><div class="muted small">Faded = observed, solid = forecast. Number = FWI.</div>`;
  }

  const geocodeCache = new Map();
  async function reverseGeocode(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    try {
      if (!geocodeCache.has(key)) {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=8&lat=${lat}&lon=${lon}`, { headers: { "Accept-Language": navigator.language } });
        const j = await r.json();
        geocodeCache.set(key, j.display_name ? j.display_name.split(",").slice(0, 3).join(",") : "");
      }
      const el = $("#place");
      if (el && geocodeCache.get(key)) el.textContent = `· ${geocodeCache.get(key)}`;
    } catch (_) { /* offline: coordinates are enough */ }
  }

  $("#whatif").addEventListener("click", () => setPicking(state.picking === "whatif" ? null : "whatif"));

  // ------------------------------------------------------------------ danger
  const PROB_BANDS = [[0.01, "#3ecf8e", "<1%"], [0.05, "#ffd84d", "1–5%"], [0.15, "#ff9a3c", "5–15%"], [0.3, "#ff4d4d", "15–30%"], [Infinity, "#a1124a", ">30%"]];
  const probColor = (p) => PROB_BANDS.find(([u]) => p < u)[1];
  const RISK_HELP = {
    fwi: "Canadian Fire Weather Index computed from 45 days of observed weather plus a 7-day forecast. Click anywhere on the map for a point outlook.",
    ignition: "Probability that at least one satellite fire detection occurs in each cell that day, from a gradient-boosted model on fire weather, land cover, terrain, season and recent fire activity.",
  };
  state.riskKind = "fwi";

  function renderLegend() {
    $("#danger-legend").innerHTML =
      state.riskKind === "fwi"
        ? Object.values(DANGER).map(([l, c]) => `<span><i class="danger-chip" style="background:${c}"></i>${l}</span>`).join("")
        : PROB_BANDS.map(([, c, l]) => `<span><i class="danger-chip" style="background:${c}"></i>${l}</span>`).join("");
  }

  $$("#risk-kind button").forEach((btn) =>
    btn.addEventListener("click", () => {
      $$("#risk-kind button").forEach((x) => x.classList.toggle("on", x === btn));
      state.riskKind = btn.dataset.v;
      $("#risk-help").textContent = RISK_HELP[state.riskKind];
      renderLegend();
      if (state.danger) loadDangerGrid();
    })
  );

  async function loadDangerGrid() {
    // Never go finer than the ~10 km weather model: expand small views to at least 3° x 2°.
    const b = map.getBounds();
    const c = b.getCenter();
    const halfW = Math.max(1.5, (b.getEast() - b.getWest()) / 2), halfH = Math.max(1, (b.getNorth() - b.getSouth()) / 2);
    const w = Math.max(-180, c.lng - halfW), e = Math.min(180, c.lng + halfW);
    const s = Math.max(-85, c.lat - halfH), n = Math.min(85, c.lat + halfH);
    const btn = $("#danger-load");
    const kind = state.riskKind;
    btn.disabled = true;
    btn.textContent = kind === "fwi" ? "Computing FWI grid…" : "Scoring ignition risk…";
    try {
      const path = kind === "fwi" ? "/api/danger/grid" : "/api/risk/ignition";
      state.danger = await api(`${path}?bbox=${w},${s},${e},${n}&n=10`);
      state.danger.kind = kind;
      $("#danger-controls").hidden = false;
      $("#danger-day").max = state.danger.dates.length - 1;
      $("#danger-day").value = Math.min(1, state.danger.dates.length - 1);
      const info = $("#model-info");
      if (kind === "ignition") {
        const m = state.danger.model;
        info.hidden = false;
        info.innerHTML = m.kind === "trained"
          ? `Trained model · ${esc(m.region || "")} · test ROC AUC <b>${m.test.roc_auc ?? "–"}</b> (FWI baseline ${m.test_baseline.roc_auc ?? "–"}) · Brier ${m.test.brier} · trained ${new Date(m.trained_at).toLocaleDateString()}`
          : `Using the heuristic baseline: no trained model yet. Run <span class="mono">python -m firealerts.ml.train</span> to fit one for your region.${m.warning ? ` (${esc(m.warning)})` : ""}`;
      } else info.hidden = true;
      renderDanger();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Show for current view";
    }
  }

  function renderDanger() {
    if (!state.danger) return;
    const day = +$("#danger-day").value;
    const ign = state.danger.kind === "ignition";
    const feats = state.danger.features.map((f) => ({
      ...f,
      properties: ign ? { color: probColor(f.properties.p[day]), p: f.properties.p[day] } : { color: DANGER[f.properties.danger[day]][1], fwi: f.properties.fwi[day] },
    }));
    map.getSource("danger").setData({ type: "FeatureCollection", features: feats });
    const d = new Date(state.danger.dates[day] + "T12:00:00");
    $("#danger-date").textContent = `${d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}${day === 0 ? " (today, observed)" : ""}`;
  }

  async function pointDanger(lat, lon) {
    const el = $("#point-danger");
    el.innerHTML = `<div class="loading">Computing fire weather</div>`;
    try {
      const d = await api(`/api/danger?lat=${lat}&lon=${lon}`);
      const today = d.days.find((x) => x.forecast) || d.days[d.days.length - 1];
      el.innerHTML = `<h3>Point outlook · <span class="mono">${lat.toFixed(3)}, ${lon.toFixed(3)}</span></h3>
        <div class="tiles">
          ${tile(`<span style="color:${DANGER[today.danger][1]}">${fmt(today.fwi)}</span>`, `FWI · ${DANGER[today.danger][0]}`)}
          ${tile(fmt(d.state.dmc), "DMC")}${tile(fmt(d.state.dc), "DC")}
          ${tile(`${fmt(d.current.temp, 1)}°`, "Temp now")}${tile(`${fmt(d.current.rh)}%`, "RH now")}${tile(`${fmt(d.current.wind)} ${compass(d.current.wind_dir)}`, "Wind km/h")}
        </div>${dangerStrip(d.days)}
        <button class="btn" id="pt-whatif">Simulate ignition here</button>`;
      $("#pt-whatif").onclick = () => {
        map.getSource("whatif-pt").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] } }] });
        openForecast({ kind: "whatif", lat, lon });
      };
    } catch (err) {
      el.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    }
  }

  $("#danger-load").addEventListener("click", loadDangerGrid);
  $("#danger-day").addEventListener("input", renderDanger);
  $("#danger-visible").addEventListener("change", (e) => map.setLayoutProperty("danger-fill", "visibility", e.target.checked ? "visible" : "none"));
  renderLegend();

  // ------------------------------------------------------------------ alerts
  async function loadAois() {
    const aois = await api("/api/aois");
    map.getSource("aois").setData({ type: "FeatureCollection", features: aois.map((a) => ({ type: "Feature", geometry: a.geometry, properties: { id: a.id, name: a.name } })) });
    $("#aoi-list").innerHTML = aois
      .map((a) => {
        const ch = [a.email && "e-mail", a.webhook_url && "webhook", a.telegram_chat_id && "telegram"].filter(Boolean).join(", ") || "in-app only";
        return `<li class="aoi" data-id="${a.id}"><div><b>${esc(a.name)}</b><div class="muted small">buffer ${a.buffer_km} km · ${ch}</div></div><button title="Delete" data-del="${a.id}">×</button></li>`;
      })
      .join("") || `<li class="muted small">No areas yet.</li>`;
    $("#aoi-list").onclick = async (e) => {
      const del = e.target.dataset.del;
      if (del) {
        if (!confirm("Delete this alert area?")) return;
        await api(`/api/aois/${del}`, { method: "DELETE" });
        loadAois();
        return;
      }
      const li = e.target.closest(".aoi");
      const a = li && aois.find((x) => x.id === +li.dataset.id);
      if (a) {
        const b = new maplibregl.LngLatBounds();
        a.geometry.coordinates[0].forEach((c) => b.extend(c));
        map.fitBounds(b, { padding: 80 });
      }
    };
  }

  async function loadAlerts() {
    const alerts = await api("/api/alerts?limit=50");
    $("#alert-list").innerHTML = alerts
      .map((a) => `<li class="alert" data-lat="${a.lat}" data-lon="${a.lon}"><div><b>${esc(a.aoi_name)}</b> · ${a.count} detection${a.count > 1 ? "s" : ""}<div class="muted small">${new Date(a.created_at).toLocaleString()} · ${a.nearest_km === 0 ? "inside" : a.nearest_km + " km away"}${a.max_frp ? ` · ${fmt(a.max_frp)} MW` : ""}</div></div></li>`)
      .join("") || `<li class="muted small">No alerts yet. New detections inside your areas will appear here.</li>`;
    $("#alert-list").onclick = (e) => {
      const li = e.target.closest(".alert");
      if (li) map.flyTo({ center: [+li.dataset.lon, +li.dataset.lat], zoom: 11 });
    };
  }

  $("#pick-center").addEventListener("click", () => setPicking(state.picking === "aoi" ? null : "aoi"));
  $("#aoi-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const [lat, lon] = String(f.get("center")).split(",").map((v) => parseFloat(v));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return toast("Centre must be 'lat, lon'");
    try {
      await api("/api/aois", {
        method: "POST",
        body: JSON.stringify({
          name: f.get("name"),
          center: [lat, lon],
          radius_km: +f.get("radius_km"),
          buffer_km: +f.get("buffer_km") || 0,
          min_confidence: f.get("min_confidence"),
          email: f.get("email") || "",
          webhook_url: f.get("webhook_url") || "",
          telegram_chat_id: f.get("telegram_chat_id") || "",
        }),
      });
      e.target.reset();
      toast("Alert area created — you'll be notified of new detections");
      loadAois();
    } catch (err) {
      toast(err.message);
    }
  });

  // ------------------------------------------------------------------ chrome
  $$(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      $$(".tab").forEach((t) => t.classList.toggle("on", t.id === `tab-${b.dataset.tab}`));
      if (b.dataset.tab === "alerts") { loadAois(); loadAlerts(); }
    })
  );
  $$("#basemap button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#basemap button").forEach((x) => x.classList.toggle("on", x === b));
      const sat = b.dataset.v === "sat";
      map.setLayoutProperty("sat", "visibility", sat ? "visible" : "none");
      map.setLayoutProperty("labels", "visibility", sat ? "visible" : "none");
      map.setLayoutProperty("dark", "visibility", sat ? "none" : "visible");
    })
  );
  $("#window").addEventListener("change", (e) => {
    state.hours = +e.target.value;
    refreshData();
  });
  $("#refresh").addEventListener("click", async () => {
    const btn = $("#refresh");
    btn.classList.add("spin");
    try {
      const r = await api("/api/ingest", { method: "POST" });
      toast(`Sync complete: ${r.inserted} new detections${r.alerts ? `, ${r.alerts} alerts` : ""}`);
      await refreshData();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.classList.remove("spin");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setPicking(null);
  });

  async function refreshData() {
    await Promise.all([loadStatus(), loadDetections(), loadIncidents()]).catch((err) => toast(err.message));
  }

  // ------------------------------------------------------------------ accounts
  const modal = {
    open(html) { $("#modal-body").innerHTML = html; $("#modal").hidden = false; },
    close() { if (state.me?.auth_required && !state.me.authenticated) return; $("#modal").hidden = true; },
  };
  $("#modal-close").addEventListener("click", () => modal.close());
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") modal.close(); });

  async function loadMe() {
    try {
      state.me = await api("/api/me");
    } catch (_) {
      state.me = { authenticated: false, auth_required: true };
    }
    renderAccount();
    return state.me;
  }

  function renderAccount() {
    const el = $("#account");
    const me = state.me || {};
    if (!me.authenticated) {
      el.innerHTML = `<button class="btn" id="signin">Sign in</button>`;
      $("#signin").onclick = () => showAuth("login");
      return;
    }
    const initials = (me.user.name || me.user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
    el.innerHTML = `<button class="account-btn" id="account-btn"><span class="avatar">${esc(initials)}</span>${esc(me.org.name)}</button>
      <div class="menu" id="account-menu" hidden>
        <div class="label">${esc(me.user.email)} · ${esc(me.role)}</div>
        <div class="sep"></div>
        <div class="label">Organisations</div>
        ${me.memberships.map((m) => `<button data-org="${m.org_id}" class="${m.org_id === me.org.id ? "current" : ""}">${esc(m.org_name)} <span class="muted small">${esc(m.role)}</span></button>`).join("")}
        <button data-act="new-org">+ New organisation</button>
        <div class="sep"></div>
        <button data-act="team">Team &amp; invites</button>
        <button data-act="keys">API keys</button>
        <div class="sep"></div>
        <button data-act="logout">Sign out</button>
      </div>`;
    $("#account-btn").onclick = (e) => { e.stopPropagation(); $("#account-menu").hidden = !$("#account-menu").hidden; };
    $("#account-menu").onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $("#account-menu").hidden = true;
      if (b.dataset.org) { store.set("fa_org", b.dataset.org); await afterAuth(); return; }
      ({ "new-org": showNewOrg, team: showTeam, keys: showKeys, logout })[b.dataset.act]?.();
    };
  }
  document.addEventListener("click", () => { const m = $("#account-menu"); if (m) m.hidden = true; });

  function showAuth(mode = "login", invite = null) {
    if (!$("#modal").hidden && $("#auth-form")) return;
    const reg = mode === "register";
    const me = state.me || {};
    modal.open(`
      <h2>${reg ? "Create your account" : "Sign in to Firealerts"}</h2>
      <div class="muted small">${invite ? `You're invited to join <b>${esc(invite.org_name)}</b> as ${esc(invite.role)}.` : reg ? "You'll get your own organisation; invite your team afterwards." : "Monitor fires, forecasts and alerts for your organisation."}</div>
      <form id="auth-form">
        ${reg ? `<label>Name <input name="name" autocomplete="name" /></label>` : ""}
        <label>E-mail <input name="email" type="email" required autocomplete="email" value="${esc(invite?.email || "")}" /></label>
        <label>Password <input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? "new-password" : "current-password"}" /></label>
        ${reg && !invite ? `<label>Organisation name <input name="org_name" placeholder="e.g. Sierra Fire Brigade" /></label>` : ""}
        <div class="error" id="auth-error"></div>
        <button class="btn primary" type="submit">${reg ? "Create account" : "Sign in"}</button>
      </form>
      <p class="small muted">${reg ? `Already have an account? <button class="linklike" id="auth-switch">Sign in</button>` : me.registration_open !== false || invite ? `New here? <button class="linklike" id="auth-switch">Create an account</button>` : "Registration is by invitation."}</p>`);
    $("#auth-switch")?.addEventListener("click", () => { $("#modal").hidden = true; showAuth(reg ? "login" : "register", invite); });
    $("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (invite) f.invite_token = invite.token;
      try {
        const r = await api(reg ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: JSON.stringify(f) });
        store.set("fa_token", r.token);
        if (invite && !reg) await api(`/api/invites/${invite.token}/accept`, { method: "POST" }).catch((err) => toast(err.message));
        const target = invite ? r.memberships.find((m) => m.org_name === invite.org_name) : null;
        store.set("fa_org", String((target || r.memberships[0] || {}).org_id || ""));
        if (invite) history.replaceState(null, "", location.pathname);
        $("#modal").hidden = true;
        await afterAuth();
        toast(reg ? "Welcome to Firealerts" : "Signed in");
      } catch (err) {
        $("#auth-error").textContent = err.message;
      }
    });
  }

  async function afterAuth() {
    await loadMe();
    if (!state.fuels.length) state.fuels = await api("/api/fuels").catch(() => []);
    if (!state.timer) state.timer = setInterval(refreshData, 120000);
    state.danger = null;
    await refreshData();
    loadAois().catch(() => {});
    loadAlerts().catch(() => {});
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    store.set("fa_token", null);
    store.set("fa_org", null);
    await loadMe();
    if (state.me.auth_required) showAuth("login");
    else await afterAuth();
  }

  function showNewOrg() {
    modal.open(`<h2>New organisation</h2><form id="org-form"><label>Name <input name="name" required /></label><div class="error" id="org-error"></div><button class="btn primary">Create</button></form>`);
    $("#org-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const o = await api("/api/orgs", { method: "POST", body: JSON.stringify({ name: new FormData(e.target).get("name") }) });
        store.set("fa_org", String(o.id));
        $("#modal").hidden = true;
        await afterAuth();
      } catch (err) { $("#org-error").textContent = err.message; }
    };
  }

  async function showTeam() {
    const me = state.me;
    const admin = ["admin", "owner"].includes(me.role);
    const owner = me.role === "owner";
    const t = await api("/api/org/members");
    const roles = ["viewer", "member", "admin", "owner"];
    const owners = t.members.filter((m) => m.role === "owner").length;
    modal.open(`
      <h2>${esc(me.org.name)}</h2><div class="muted small">You are ${esc(me.role)}.</div>
      <h3>Members</h3>
      <table>${t.members.map((m) => `<tr><td>${esc(m.name || m.email)}<div class="muted small">${esc(m.email)}</div></td>
        <td>${owner ? `<select data-role="${m.user_id}">${roles.map((r) => `<option ${r === m.role ? "selected" : ""}>${r}</option>`).join("")}</select>` : esc(m.role)}</td>
        <td>${(admin || m.user_id === me.user.id) && !(m.role === "owner" && owners === 1) ? `<button class="linklike" data-remove="${m.user_id}">${m.user_id === me.user.id ? "Leave" : "Remove"}</button>` : ""}</td></tr>`).join("")}</table>
      ${t.pending_invites.length ? `<h3>Pending invites</h3><table>${t.pending_invites.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.role)}</td><td>${admin ? `<button class="linklike" data-revoke="${i.id}">Revoke</button>` : ""}</td></tr>`).join("")}</table>` : ""}
      ${admin ? `<h3>Invite someone</h3><form id="invite-form"><div class="row2"><label>E-mail <input name="email" type="email" required /></label>
        <label>Role <select name="role">${roles.filter((r) => owner || r !== "owner").map((r) => `<option ${r === "member" ? "selected" : ""}>${r}</option>`).join("")}</select></label></div>
        <div class="error" id="invite-error"></div><button class="btn primary">Create invite</button></form><div id="invite-result"></div>` : ""}`);
    $("#modal-body").onchange = async (e) => {
      const uid = e.target.dataset.role;
      if (!uid) return;
      try { await api(`/api/org/members/${uid}`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }); toast("Role updated"); } catch (err) { toast(err.message); showTeam(); }
    };
    $("#modal-body").onclick = async (e) => {
      const rm = e.target.dataset.remove, rv = e.target.dataset.revoke;
      try {
        if (rm && confirm("Remove this member?")) { await api(`/api/org/members/${rm}`, { method: "DELETE" }); if (+rm === me.user.id) { store.set("fa_org", null); $("#modal").hidden = true; return afterAuth(); } showTeam(); }
        if (rv) { await api(`/api/org/invites/${rv}`, { method: "DELETE" }); showTeam(); }
      } catch (err) { toast(err.message); }
    };
    $("#invite-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const r = await api("/api/org/invites", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
        $("#invite-result").innerHTML = `<p class="small">${r.emailed ? "Invite e-mailed. You can also share this link:" : "Share this link (valid 14 days):"}</p><div class="secret">${esc(r.invite_url)}</div>`;
        e.target.reset();
      } catch (err) { $("#invite-error").textContent = err.message; }
    });
  }

  async function showKeys() {
    const keys = await api("/api/keys");
    modal.open(`
      <h2>API keys</h2><div class="muted small">Use with <span class="mono">Authorization: Bearer &lt;key&gt;</span> and optionally <span class="mono">X-Org-Id</span>. Keys act with your permissions.</div>
      <table>${keys.map((k) => `<tr><td>${esc(k.name)}<div class="muted small mono">${esc(k.prefix)}…</div></td><td class="small muted">${k.last_used_at ? "used " + timeAgo(new Date(k.last_used_at)) : "never used"}</td><td><button class="linklike" data-del="${k.id}">Revoke</button></td></tr>`).join("") || `<tr><td class="muted small">No keys yet.</td></tr>`}</table>
      <form id="key-form"><label>Name <input name="name" required placeholder="e.g. dispatch integration" /></label><button class="btn primary">Create key</button></form><div id="key-result"></div>`);
    $("#modal-body").onclick = async (e) => { if (e.target.dataset.del && confirm("Revoke this key?")) { await api(`/api/keys/${e.target.dataset.del}`, { method: "DELETE" }); showKeys(); } };
    $("#key-form").onsubmit = async (e) => {
      e.preventDefault();
      const r = await api("/api/keys", { method: "POST", body: JSON.stringify({ name: new FormData(e.target).get("name") }) });
      $("#key-result").innerHTML = `<p class="small">${esc(r.note)}</p><div class="secret">${esc(r.key)}</div>`;
    };
  }

  async function handleInviteLink() {
    const m = location.hash.match(/invite=([\w-]+)/);
    if (!m) return false;
    try {
      const info = await api(`/api/invites/${m[1]}`);
      const invite = { ...info, token: m[1] };
      if (state.me.authenticated) {
        await api(`/api/invites/${m[1]}/accept`, { method: "POST" });
        history.replaceState(null, "", location.pathname);
        toast(`Joined ${info.org_name}`);
        await afterAuth();
      } else showAuth("register", invite);
    } catch (err) {
      toast(err.message);
    }
    return true;
  }

  async function boot() {
    await loadMe();
    const invited = await handleInviteLink();
    if (state.me.auth_required && !state.me.authenticated) {
      if (!invited) showAuth("login");
      return;
    }
    state.fuels = await api("/api/fuels").catch(() => []);
    await refreshData();
    loadAois().catch(() => {});
    state.timer = setInterval(refreshData, 120000);
  }
})();

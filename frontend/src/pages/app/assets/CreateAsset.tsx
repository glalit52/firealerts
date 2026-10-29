/* Create assets by drawing (polygon / circle) or by uploading GeoJSON, KML/KMZ or zipped Shapefiles. */
import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { assets as assetsApi } from "../../../api/endpoints";
import type { AssetListItem, ImportResult } from "../../../api/types";
import { useAuth } from "../../../auth/AuthContext";
import { AssetFields, defaultAssetValues, valuesToPayload } from "../../../components/AssetFields";
import type { AssetFormValues } from "../../../components/AssetFields";
import { IconCheck, IconCircle, IconCrosshair, IconPolygon, IconUndo, IconUpload, IconX } from "../../../components/Icons";
import { useToast } from "../../../components/Toast";
import { Button, Input, Modal, Notice, Select, Tabs } from "../../../components/ui";
import { fmtHa, fmtNum, humanize } from "../../../lib/format";
import { DrawController, drawResult, emptyDraw } from "../../../map/draw";
import type { DrawMode, DrawState } from "../../../map/draw";
import { MapView } from "../../../map/MapView";
import { addAssetLayers, assetsToFC, fitGeometry, setData } from "../../../map/utils";

function DrawTab({ existing, onCreated }: { existing: AssetListItem[]; onCreated: (id: number) => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [map, setMap] = useState<MlMap | null>(null);
  const ctl = useRef<DrawController | null>(null);
  const [state, setState] = useState<DrawState>(emptyDraw());
  const [drawing, setDrawing] = useState(false);
  const [values, setValues] = useState<AssetFormValues>(() => defaultAssetValues(me?.org?.settings?.default_buffer_km ?? 2));
  const [goto, setGoto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onReady = useCallback(
    (m: MlMap) => {
      addAssetLayers(m, "existing");
      setData(m, "existing", assetsToFC(existing));
      const withGeom = existing.filter((a) => a.geometry);
      if (withGeom.length) fitGeometry(m, withGeom.map((a) => a.geometry!), { padding: 60, maxZoom: 10 });
      ctl.current = new DrawController(m, setState, (r) => {
        if (r.ok) setDrawing(false);
      });
      setMap(m);
    },
    [existing],
  );

  useEffect(() => () => ctl.current?.destroy(), []);

  const start = (mode: DrawMode) => {
    ctl.current?.start(mode);
    setDrawing(true);
    setError(null);
  };

  const result = drawResult(state);
  const hasShape = state.mode === "polygon" ? state.vertices.length > 0 : !!state.center;
  const limitHa = me?.org?.limits?.max_asset_ha;

  const hint = !drawing
    ? result.ok
      ? `Area ready: ${fmtHa(result.areaHa)}. Fill in the details and save.`
      : "Choose Polygon or Circle, then click on the map."
    : state.mode === "polygon"
      ? state.vertices.length < 3
        ? `Click to add points (${state.vertices.length}/3 minimum). Backspace undoes.`
        : "Click the first point, double-click or press Enter to finish."
      : !state.center
        ? "Click to place the centre."
        : "Click again to set the radius, or type it in the toolbar.";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!values.name.trim()) return setError("Give the asset a name.");
    if (!result.ok) return setError(result.reason);
    if (limitHa != null && result.areaHa > limitHa) return setError(`Your plan allows assets up to ${fmtNum(limitHa)} ha; this one is ${fmtNum(result.areaHa)} ha.`);
    setBusy(true);
    setError(null);
    try {
      const body = { ...valuesToPayload(values), name: values.name.trim() };
      const a =
        state.mode === "circle" && result.center && result.radiusKm
          ? await assetsApi.create({ ...body, center: [result.center[1], result.center[0]], radius_km: Math.round(result.radiusKm * 1000) / 1000 })
          : await assetsApi.create({ ...body, geometry: result.polygon });
      toast.success(`${a.name} is now monitored (${fmtHa(a.area_ha)}).`);
      onCreated(a.id);
    } catch (err) {
      toast.error(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="draw-layout" onSubmit={submit}>
      <div className="draw-map">
        <MapView onReady={onReady} ariaLabel="Draw an asset">
          <div className="draw-tools map-overlay">
            <Button size="sm" icon={<IconPolygon />} active={drawing && state.mode === "polygon"} onClick={() => start("polygon")}>
              Polygon
            </Button>
            <Button size="sm" icon={<IconCircle />} active={drawing && state.mode === "circle"} onClick={() => start("circle")}>
              Circle
            </Button>
            {drawing && state.mode === "circle" && state.center && (
              <input
                className="input sm"
                style={{ width: 96 }}
                type="number"
                min={0.1}
                max={200}
                step={0.1}
                placeholder="radius km"
                aria-label="Radius in km"
                value={state.radiusKm ? Math.round(state.radiusKm * 100) / 100 : ""}
                onChange={(e) => ctl.current?.setRadius(+e.target.value)}
              />
            )}
            {hasShape && (
              <Button size="sm" icon={<IconUndo />} onClick={() => ctl.current?.undo()} disabled={!drawing} title="Undo (Backspace)">
                Undo
              </Button>
            )}
            {drawing && (
              <Button size="sm" variant="primary" icon={<IconCheck />} onClick={() => ctl.current?.finish()} disabled={!result.ok}>
                Finish
              </Button>
            )}
            {(drawing || hasShape) && (
              <Button
                size="sm"
                variant="ghost"
                icon={<IconX />}
                onClick={() => {
                  ctl.current?.cancel();
                  setDrawing(false);
                }}
              >
                Clear
              </Button>
            )}
            <span className="row" style={{ gap: 4 }}>
              <input
                className="input sm"
                style={{ width: 150 }}
                placeholder="Go to lat, lon"
                aria-label="Go to coordinates"
                value={goto}
                onChange={(e) => setGoto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const [la, lo] = goto.split(/[,\s]+/).map(Number);
                  if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la!) <= 90 && Math.abs(lo!) <= 180) map?.flyTo({ center: [lo!, la!], zoom: 11 });
                  else toast.show("Enter coordinates as “lat, lon”, e.g. -31.25, -64.65", "warning");
                }}
              />
              <Button size="sm" iconOnly aria-label="Go" title="Go to coordinates" onClick={() => {
                const [la, lo] = goto.split(/[,\s]+/).map(Number);
                if (Number.isFinite(la) && Number.isFinite(lo)) map?.flyTo({ center: [lo!, la!], zoom: 11 });
              }}>
                <IconCrosshair />
              </Button>
            </span>
          </div>
          <div className="draw-hint map-overlay" role="status">
            {hint}
          </div>
        </MapView>
      </div>
      <div className="stack">
        <div className="card inset" style={{ padding: 12 }}>
          <div className="row between small">
            <span className="muted">Area</span>
            <b className="num">{result.ok ? fmtHa(result.areaHa) : "–"}</b>
          </div>
          {limitHa != null && (
            <div className="tiny muted mt-4">
              Plan limit {fmtNum(limitHa)} ha per asset
              {result.ok && result.areaHa > limitHa && <span className="bad-text"> · too large</span>}
            </div>
          )}
          {!result.ok && hasShape && !drawing && <div className="tiny warn-text mt-4">{result.reason}</div>}
        </div>
        <AssetFields value={values} onChange={setValues} compact />
        {error && <div className="form-error" role="alert">{error}</div>}
        <Button type="submit" variant="primary" loading={busy} disabled={!result.ok || drawing}>
          Create asset
        </Button>
      </div>
    </form>
  );
}

function UploadTab({ onDone }: { onDone: (r: ImportResult) => void }) {
  const { meta, me } = useAuth();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("forest");
  const [buffer, setBuffer] = useState<number>(me?.org?.settings?.default_buffer_km ?? 2);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/\.(geojson|json|kml|kmz|zip)$/i.test(f.name)) {
      toast.show("Supported formats: .geojson, .json, .kml, .kmz, or a .zip containing a Shapefile.", "warning");
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      toast.show("Files can be up to 20 MB.", "warning");
      return;
    }
    setFile(f);
    setResult(null);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await assetsApi.import(file, kind, buffer);
      setResult(r);
      if (r.created.length) toast.success(`Imported ${r.created.length} asset${r.created.length === 1 ? "" : "s"}.`);
      onDone(r);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <label
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pick(e.dataTransfer.files?.[0]);
        }}
      >
        <input ref={input} type="file" accept=".geojson,.json,.kml,.kmz,.zip" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} aria-label="Boundary file" />
        <IconUpload size={22} />
        <div className="strong mt-8" style={{ color: "var(--text)" }}>
          {file ? file.name : "Drop a boundary file here, or click to browse"}
        </div>
        <div className="small mt-4">{file ? `${fmtNum(file.size / 1024, 0)} KB` : "GeoJSON, KML, KMZ or zipped Shapefile (.zip with .shp/.dbf/.prj) · max 20 MB"}</div>
      </label>
      <div className="form-grid">
        <Select label="Kind for imported areas" value={kind} onChange={(e) => setKind(e.target.value)} options={(meta?.asset_kinds ?? ["forest"]).map((k) => ({ value: k, label: humanize(k) }))} />
        <Input label="Detection buffer (km)" type="number" min={0} max={100} step={0.5} value={buffer} onChange={(e) => setBuffer(+e.target.value)} />
      </div>
      <p className="small muted">Each polygon feature becomes one asset, named from its “name”/“NAME” attribute. Other attributes are kept as properties. You can fine-tune each asset afterwards.</p>
      <div className="row">
        <Button variant="primary" icon={<IconUpload />} disabled={!file} loading={busy} onClick={submit}>
          Import
        </Button>
        {file && (
          <Button variant="ghost" onClick={() => (setFile(null), setResult(null), input.current && (input.current.value = ""))}>
            Choose another file
          </Button>
        )}
      </div>
      {result && (
        <div className="stack tight">
          {result.created.length > 0 && (
            <Notice kind="ok" title={`${result.created.length} asset${result.created.length === 1 ? "" : "s"} created`}>
              {result.created
                .slice(0, 8)
                .map((a) => `${a.name} (${fmtHa(a.area_ha)})`)
                .join(", ")}
              {result.created.length > 8 ? "…" : ""}
            </Notice>
          )}
          {result.errors.length > 0 && (
            <Notice kind="warn" title={`${result.errors.length} feature${result.errors.length === 1 ? "" : "s"} skipped`}>
              {result.errors.slice(0, 6).map((e) => `#${e.feature + 1}: ${e.error}`).join(" · ")}
            </Notice>
          )}
          {result.created.length === 0 && result.errors.length === 0 && <Notice kind="warn">No polygon features were found in this file.</Notice>}
        </div>
      )}
    </div>
  );
}

export function CreateAssetModal({ open, onClose, existing, onChanged }: { open: boolean; onClose: () => void; existing: AssetListItem[]; onChanged: () => void }) {
  const [tab, setTab] = useState<"draw" | "upload">("draw");
  const navigate = useNavigate();
  return (
    <Modal open={open} onClose={onClose} title="Add a forest or asset" description="Draw the boundary on the map, or import existing boundaries from a file." size="xwide">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "draw", label: "Draw on map" },
          { id: "upload", label: "Upload file" },
        ]}
        label="Create method"
      />
      <div className="mt-16">
        {tab === "draw" ? (
          <DrawTab
            existing={existing}
            onCreated={(id) => {
              onChanged();
              onClose();
              navigate(`/app/assets/${id}`);
            }}
          />
        ) : (
          <UploadTab onDone={() => onChanged()} />
        )}
      </div>
    </Modal>
  );
}

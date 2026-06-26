import { displayModeLabel, mountControls, setControlSeed, setControlStatus, setRegionNavState, setViewDisplay, setSimTimeDisplay, type MetricsUiState } from "./controls";
import {
  clampPan,
  renderClimateMergedMap,
  renderClimateScalarMap,
  renderClimateContourOverlay,
  renderClimateWindField,
  renderCycloneOverlay,
  renderElementMap,
  renderElementOverlays,
  renderElementContextBase,
  renderGeologyMap,
  renderSurfaceMap,
  renderWaterMap,
  renderStructureMap,
  renderCrustMap,
  renderTerrainContourOverlay,
  renderRegionGridOverlay,
  screenToWorldKm,
  type TerrainContourMode,
  renderLayer,
  renderMapRulers,
  updateMapInfoPanel,
  type MapInfoData,
  setHeightColorScale,
  ZOOM_LEVELS,
  DEFAULT_ZOOM_INDEX,
} from "./render";
import { drawAreaHistogram, drawJitterChart, drawProfileHeatmap } from "./charts";
import {
  buildAreaHistogram,
  buildJitterProfile,
  buildProfileHeatmap,
  METRIC_DIMENSIONS,
} from "./metrics";
import { computeSurfaceClimate } from "./surface";
import { initEcology, tickEcologyYear, ecologyPoolSummary } from "./ecology";
import { climateSummary, initClimateFields, tickClimateFrame, tickClimateStep, buildMeteoFields, climateStepDaysForSpan, warmupClimate } from "./climate";
import { assignHeights, getHeightDiagnostics, heightStats } from "./terrain";
import { attachGeoFrame } from "./geoFrame";
import { computeElements, geologyStats } from "./elements";
import { generateGeoFeatures, type GeoFeature } from "./geoFeatures";
import {
  DEFAULT_CLOUD,
  DEFAULT_CLIMATE_UI,
  DEFAULT_ECOLOGY,
  DEFAULT_TERRAIN,
  DEFAULT_VORONOI,
  type BaseLayer,
  type ClimateUiState,
  type CloudParams,
  type EcologyParams,
  type ElementKey,
  type MapLayer,
  type TerrainParams,
  type SimAdvanceUnit,
  SIM_ADVANCE_SPECS,
  simUnitHours,
  simUnitToDays,
} from "./types";
import { coEvolveTectonics, orogenAmplifier, riftAmplifier, effectiveContinentCount, refreshTectonicBias } from "./tectonicLoop";
import { generateGeologicalStructures } from "./geologyFromTectonics";
import {
  buildContinentalCrustField,
  evolveCrustTerrain,
  type CrustEvolutionState,
} from "./crustEvolution";
import type { TectonicState } from "./cellGraph";
import { createMacroLayer, generateVoronoi, resetCellMeshFromSeed } from "./voronoi";
import {
  buildWorldSave,
  getRegionSummary,
  loadWorldFromStorage,
  markRegionGenerated,
  saveWorldToStorage,
  type WorldSave,
} from "./worldSave";
import {
  createRegionLayer,
  enforceMacroConsistency,
  terrainParamsForRegion,
} from "./regionGen";
import { generatedRegionKeys, regionStatusText } from "./regionPicker";
import { regionIndexAtKm, isPlanetLayer } from "./regionGrid";
import type { VoronoiConfig } from "./types";

const canvas = document.getElementById("map-canvas") as HTMLCanvasElement;
const controlsEl = document.getElementById("controls") as HTMLElement;
const wrap = document.getElementById("canvas-wrap") as HTMLElement;
const mapInfoEl = document.getElementById("map-info") as HTMLElement;
const chartArea = document.getElementById("chart-area") as HTMLCanvasElement;
const chartJitter = document.getElementById("chart-jitter") as HTMLCanvasElement;
const chartProfile = document.getElementById("chart-profile") as HTMLCanvasElement;
const metricsShell = document.getElementById("metrics-shell") as HTMLElement;
const metricsToggle = document.getElementById("metrics-toggle") as HTMLButtonElement;
const ctx = canvas.getContext("2d")!;

const terrainCache = document.createElement("canvas");
const cacheCtx = terrainCache.getContext("2d")!;

let layer: MapLayer;
let terrainParams: TerrainParams = { ...DEFAULT_TERRAIN };
let cloudParams: CloudParams = { ...DEFAULT_CLOUD };
let ecologyParams: EcologyParams = { ...DEFAULT_ECOLOGY };
let ecologyDay = 0;
let climateTimeDays = 0;
let controlState: ReturnType<typeof mountControls>;
let flatOcean = false;
let showCoastline = true;
let showHeightContours = false;
let baseLayer: BaseLayer = "height";
let climateUi: ClimateUiState = { ...DEFAULT_CLIMATE_UI };
let elementOverlays: ElementKey[] = [];
let geoFeatures: GeoFeature[] = [];
let tectonicState: TectonicState | null = null;
let crustState: CrustEvolutionState | null = null;
let metricsUi: MetricsUiState = { dimension: "height", scope: "land", profileAxis: "x" };

let planetLayer: MapLayer | null = null;
let planetTectonic: TectonicState | null = null;
let worldSave: WorldSave | null = loadWorldFromStorage();
let activeRegion: { col: number; row: number } | null = null;
let blockVoronoiConfig: VoronoiConfig = { ...DEFAULT_VORONOI };
let baseTerrainParams: TerrainParams = { ...DEFAULT_TERRAIN };
let regionPickMode = false;
let hoverRegion: { col: number; row: number } | null = null;

function setRegionPickMode(on: boolean): void {
  regionPickMode = on;
  hoverRegion = null;
  canvas.style.cursor = on ? "crosshair" : "grab";
  const btn = document.getElementById("btn-pick-region") as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = on ? "取消选区" : "在地图上选片区";
    btn.classList.toggle("active-pick", on);
  }
  if (on) {
    setControlStatus("在地图上点击 1000×1000 km 片区下钻 · Esc 取消");
  }
  draw();
}

function toggleRegionPickMode(): void {
  if (regionPickMode) {
    setRegionPickMode(false);
    return;
  }
  if (!worldSave || !planetLayer || !layer || !isPlanetLayer(layer)) {
    setControlStatus("请先生成全球图并存档");
    return;
  }
  setRegionPickMode(true);
}

function canvasClientToLocal(clientX: number, clientY: number): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [clientX - rect.left, clientY - rect.top];
}

function pickRegionAtScreen(clientX: number, clientY: number): { col: number; row: number } | null {
  if (!layer || !worldSave) return null;
  const [sx, sy] = canvasClientToLocal(clientX, clientY);
  const world = screenToWorldKm(layer, cssW, cssH, sx, sy, currentZoom(), panX, panY);
  if (!world) return null;
  return regionIndexAtKm(world[0], world[1]);
}

function currentVoronoiConfig(): VoronoiConfig {
  if (layer?.level === "block") return { ...blockVoronoiConfig };
  return { ...DEFAULT_VORONOI, seed: terrainParams.seed };
}

function syncRegionNavUi(): void {
  const mode = layer?.level === "block" ? "region" : "planet";
  setRegionNavState(mode, worldSave !== null);
}

function updateMetricsCharts(): void {
  if (!layer) return;
  const dim = metricsUi.dimension;
  const label = METRIC_DIMENSIONS.find((d) => d.id === dim)?.label ?? dim;
  const hist = buildAreaHistogram(layer.cells, dim, metricsUi.scope);
  drawAreaHistogram(chartArea, hist, label, dim);
  const jitter = buildJitterProfile(
    layer.cells,
    dim,
    metricsUi.scope,
    40,
    getHeightDiagnostics()
  );
  drawJitterChart(chartJitter, jitter, label, dim === "height", dim);
  const profile = buildProfileHeatmap(
    layer.cells,
    dim,
    metricsUi.scope,
    layer.bounds,
    metricsUi.profileAxis
  );
  drawProfileHeatmap(chartProfile, profile, dim);
}

let cssW = 0;
let cssH = 0;
let dpr = 1;

let lastTs = 0;
let simBusy = false;
let climateCacheFrame = 0;
let layerSwitchPending = false;

function scheduleLayerRedraw(): void {
  if (layerSwitchPending) return;
  layerSwitchPending = true;
  requestAnimationFrame(() => {
    layerSwitchPending = false;
    if (!layer) return;
    try {
      rebuildTerrainCache();
      draw();
    } catch (err) {
      console.error("layer redraw failed", err);
      setControlStatus("气候层渲染失败，请查看控制台");
    }
  });
}

function resizeCanvas(): void {
  const rect = wrap.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  cssW = rect.width;
  cssH = rect.height;

  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  terrainCache.width = canvas.width;
  terrainCache.height = canvas.height;

  applyViewClamp();
  rebuildTerrainCache();
  draw();
  updateMetricsCharts();
  setViewDisplay(zoomIndex);
}

function needsFullTectonicRecompute(prev: TerrainParams, next: TerrainParams): boolean {
  return (
    prev.seed !== next.seed ||
    prev.continentCount !== next.continentCount ||
    prev.tectonicIterations !== next.tectonicIterations ||
    prev.landCentric !== next.landCentric ||
    prev.singleContinent !== next.singleContinent ||
    prev.oceanRing !== next.oceanRing ||
    prev.oceanRatio !== next.oceanRatio ||
    prev.meshUniformity !== next.meshUniformity ||
    prev.decay !== next.decay
  );
}

function needsBiasRefresh(prev: TerrainParams, next: TerrainParams): boolean {
  return prev.mountainCount !== next.mountainCount || prev.basinCount !== next.basinCount;
}

let fullTectonicTimer: ReturnType<typeof setTimeout> | null = null;
const FULL_TECTONIC_DEBOUNCE_MS = 450;

function convergentBias(): number {
  const m = terrainParams.mountainCount;
  return Math.min(1, 0.15 + m * 0.11);
}

function riftBias(): number {
  const b = terrainParams.basinCount;
  return Math.min(1, 0.12 + b * 0.11);
}

function resetMeshFromSeed(): void {
  if (!layer) return;
  layer.cells = resetCellMeshFromSeed(currentVoronoiConfig());
  tectonicState = null;
  crustState = null;
}

function runTectonicLoop(): void {
  if (!layer) return;
  if (!layer.geoFrame) attachGeoFrame(layer);
  resetMeshFromSeed();
  tectonicState = coEvolveTectonics(layer.cells, {
    seed: terrainParams.seed,
    iterations: terrainParams.tectonicIterations,
    continentCount: effectiveContinentCount(terrainParams),
    convergentBias: convergentBias(),
    riftBias: riftBias(),
    meshUniformity: terrainParams.meshUniformity,
    orogenAmp: orogenAmplifier(terrainParams.mountainCount),
    riftAmp: riftAmplifier(terrainParams.basinCount),
    bounds: layer.bounds,
    landCentric: terrainParams.landCentric,
    singleContinent: terrainParams.singleContinent,
    oceanRing: layer.level === "macro" ? terrainParams.oceanRing : false,
    oceanRatio: terrainParams.oceanRatio,
    decay: terrainParams.decay,
    toroidalLon: layer.level === "macro",
  });
}

function refreshBiasOnly(): void {
  if (!layer || !tectonicState) return;
  tectonicState = refreshTectonicBias(layer.cells, tectonicState, {
    seed: terrainParams.seed,
    convergentBias: convergentBias(),
    riftBias: riftBias(),
    orogenAmp: orogenAmplifier(terrainParams.mountainCount),
    riftAmp: riftAmplifier(terrainParams.basinCount),
  });
}

function finishPipeline(statusMsg = "地形已更新"): void {
  if (!layer) return;
  if (tectonicState) {
    const continentalCrust = buildContinentalCrustField(
      layer.cells,
      tectonicState,
      terrainParams
    );
    tectonicState = generateGeologicalStructures(
      layer.cells,
      tectonicState,
      {
        seed: terrainParams.seed,
        orogenAmp: tectonicState.orogenAmp ?? orogenAmplifier(terrainParams.mountainCount),
        riftAmp: tectonicState.riftAmp ?? riftAmplifier(terrainParams.basinCount),
      },
      continentalCrust
    );
    crustState = evolveCrustTerrain(
      layer.cells,
      tectonicState,
      continentalCrust,
      terrainParams
    );
    geoFeatures = [];
  } else {
    crustState = null;
    geoFeatures = generateGeoFeatures(terrainParams);
  }
  assignHeights(
    layer.cells,
    terrainParams,
    geoFeatures,
    tectonicState,
    layer.bounds,
    crustState
  );
  computeElements(
    layer.cells,
    terrainParams.seed,
    geoFeatures,
    terrainParams.veinDensity,
    tectonicState
  );
  attachGeoFrame(layer);
  const climateSeed =
    layer.level === "block" && worldSave ? worldSave.seed : terrainParams.seed;
  computeSurfaceClimate(layer.cells, layer.bounds, terrainParams.maxHeight, 0, climateSeed);
  setControlStatus("气候预热中…");
  initClimateFields(layer.cells, layer.bounds, cloudParams, 0, climateSeed);
  const warmedDays = warmupClimate(layer.cells, layer.bounds, cloudParams, 180, climateSeed);
  buildMeteoFields(layer.cells, layer.bounds, warmedDays, climateSeed);
  initEcology(layer.cells);
  climateTimeDays = warmedDays;
  ecologyDay = Math.floor(climateTimeDays);
  rebuildTerrainCache();
  draw();
  updateMetricsCharts();
  setSimTimeDisplay(climateTimeDays);
  if (layer.level === "block" && planetLayer && activeRegion && worldSave) {
    const summary = getRegionSummary(worldSave, activeRegion.col, activeRegion.row);
    if (summary) {
      enforceMacroConsistency(layer, planetLayer, summary);
      buildMeteoFields(layer.cells, layer.bounds, climateTimeDays, worldSave.seed);
      markRegionGenerated(worldSave, activeRegion.col, activeRegion.row);
      saveWorldToStorage(worldSave);
      rebuildTerrainCache();
      draw();
    }
    setControlStatus(`${statusMsg} · 片区 [${activeRegion.col},${activeRegion.row}] 已与全球对齐`);
  } else if (layer.level === "macro") {
    planetLayer = layer;
    planetTectonic = tectonicState;
    worldSave = buildWorldSave(layer, baseTerrainParams, tectonicState);
    saveWorldToStorage(worldSave);
    setControlStatus(`${statusMsg} · 全球已存档，可选择片区下钻`);
  } else {
    setControlStatus(statusMsg);
  }
  syncRegionNavUi();
}

function runPipeline(mode: "fast" | "bias" | "full"): void {
  if (!layer) return;
  if (mode === "full") {
    setControlStatus("构造共演化计算中…（约数秒，请稍候）");
    runTectonicLoop();
    finishPipeline("构造共演化完成");
    return;
  }
  if (mode === "bias") {
    setControlStatus("更新汇聚/裂谷…");
    refreshBiasOnly();
    finishPipeline("汇聚/裂谷已更新");
    return;
  }
  finishPipeline();
}

function scheduleFullTectonic(): void {
  if (fullTectonicTimer) clearTimeout(fullTectonicTimer);
  setControlStatus("待计算…（松手或停滑后自动运行）");
  fullTectonicTimer = setTimeout(() => {
    fullTectonicTimer = null;
    runPipeline("full");
  }, FULL_TECTONIC_DEBOUNCE_MS);
}

function cancelScheduledFull(): void {
  if (fullTectonicTimer) {
    clearTimeout(fullTectonicTimer);
    fullTectonicTimer = null;
  }
}

function buildLayer(seed: number): void {
  cancelScheduledFull();
  activeRegion = null;
  baseTerrainParams = { ...terrainParams, seed };
  const voronoiConfig = { ...DEFAULT_VORONOI, seed };
  const cells = generateVoronoi(voronoiConfig);
  layer = createMacroLayer(cells, voronoiConfig);
  terrainParams.seed = seed;
  geoFeatures = [];
  tectonicState = null;
  crustState = null;
  planetLayer = null;
  planetTectonic = null;
  worldSave = null;
  resetView();
  syncRegionNavUi();
  runPipeline("full");
}

function finalizeWorldSave(): void {
  if (!layer || layer.level !== "macro") {
    setControlStatus("请先生成全球图");
    return;
  }
  worldSave = buildWorldSave(layer, baseTerrainParams, tectonicState);
  saveWorldToStorage(worldSave);
  planetLayer = layer;
  planetTectonic = tectonicState;
  syncRegionNavUi();
  setControlStatus(`全球已存档 · ${worldSave.regions.length} 个片区摘要`);
}

function drillDownRegion(col: number, row: number): void {
  setRegionPickMode(false);
  if (!worldSave || !planetLayer) {
    setControlStatus("请先生成并存档全球图");
    return;
  }
  const summary = getRegionSummary(worldSave, col, row);
  if (!summary) return;
  cancelScheduledFull();
  activeRegion = { col, row };
  const regionalTerrain = terrainParamsForRegion(
    baseTerrainParams,
    summary,
    worldSave.seed,
    col,
    row
  );
  const { layer: blockLayer, voronoiConfig } = createRegionLayer(summary, worldSave.seed);
  layer = blockLayer;
  blockVoronoiConfig = voronoiConfig;
  terrainParams = { ...regionalTerrain };
  prevTerrainParams = { ...terrainParams };
  tectonicState = null;
  crustState = null;
  resetView();
  syncRegionNavUi();
  setControlStatus(`生成片区 [${col},${row}] …`);
  runPipeline("full");
}

function returnToPlanet(): void {
  if (!planetLayer) return;
  cancelScheduledFull();
  layer = planetLayer;
  tectonicState = planetTectonic;
  activeRegion = null;
  terrainParams = { ...baseTerrainParams };
  prevTerrainParams = { ...terrainParams };
  resetView();
  syncRegionNavUi();
  rebuildTerrainCache();
  draw();
  updateMetricsCharts();
  setControlStatus("已返回全球图");
}

function handleTerrainChange(params: TerrainParams): void {
  const prev = prevTerrainParams;
  const full = needsFullTectonicRecompute(prev, params);
  const bias = needsBiasRefresh(prev, params);
  prevTerrainParams = { ...params };
  terrainParams = { ...params };

  if (full) {
    scheduleFullTectonic();
    return;
  }
  cancelScheduledFull();
  if (bias) {
    runPipeline("bias");
  } else {
    runPipeline("fast");
  }
}

let zoomIndex = DEFAULT_ZOOM_INDEX;
let panX = 0;
let panY = 0;

function currentZoom(): number {
  return ZOOM_LEVELS[zoomIndex];
}

function resetView(): void {
  zoomIndex = DEFAULT_ZOOM_INDEX;
  panX = 0;
  panY = 0;
}

function applyViewClamp(): void {
  if (!layer || cssW === 0) return;
  const c = clampPan(layer, cssW, cssH, currentZoom(), panX, panY);
  panX = c.panX;
  panY = c.panY;
}

function refreshView(): void {
  applyViewClamp();
  rebuildTerrainCache();
  draw();
  setViewDisplay(zoomIndex);
}

function rebuildTerrainCache(): void {
  if (!layer || cssW === 0) return;
  const zoom = currentZoom();
  cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (elementOverlays.length > 0) {
    renderElementContextBase(cacheCtx, layer, cssW, cssH, zoom, panX, panY);
  } else if (baseLayer === "height") {
    renderLayer(cacheCtx, layer, cssW, cssH, { flatOcean, zoom, panX, panY });
  } else if (baseLayer === "geology") {
    renderGeologyMap(cacheCtx, layer, cssW, cssH, zoom, panX, panY);
  } else if (baseLayer === "structure") {
    renderStructureMap(cacheCtx, layer, tectonicState, cssW, cssH, zoom, panX, panY);
  } else if (baseLayer === "crust") {
    renderCrustMap(cacheCtx, layer, tectonicState, cssW, cssH, zoom, panX, panY);
  } else if (baseLayer === "surface") {
    renderSurfaceMap(cacheCtx, layer, cssW, cssH, zoom, panX, panY);
  } else if (baseLayer === "water") {
    renderWaterMap(cacheCtx, layer, cssW, cssH, zoom, panX, panY);
  } else if (baseLayer === "climate") {
    if (climateUi.displayMode === "merged") {
      renderClimateMergedMap(cacheCtx, layer, cssW, cssH, zoom, panX, panY);
    } else {
      renderClimateScalarMap(
        cacheCtx,
        layer,
        climateUi.scalarLayer,
        cssW,
        cssH,
        zoom,
        panX,
        panY
      );
    }
  } else if (baseLayer === "dominant") {
    renderElementMap(cacheCtx, layer, cssW, cssH, "dominant", zoom, panX, panY);
  }
}

function buildMapInfoData(): MapInfoData | null {
  if (!layer) return null;

  const stats = heightStats(layer.cells);
  const overlay: MapInfoData = {
    cellCount: layer.cells.length,
    maxHeight: terrainParams.maxHeight,
    decay: terrainParams.decay,
    seed: terrainParams.seed,
    heightMin: stats.min,
    heightMax: stats.max,
    landRatio: stats.landRatio,
    displayLabel: displayModeLabel(baseLayer, elementOverlays),
    mountainCount: terrainParams.mountainCount,
    basinCount: terrainParams.basinCount,
    continentCount: effectiveContinentCount(terrainParams),
    oceanPlateCount: tectonicState
      ? tectonicState.plates.filter((p) => !p.continental).length
      : undefined,
  };
  if (baseLayer === "geology") {
    overlay.geologyFrac = geologyStats(layer.cells);
  }
  if (baseLayer === "structure" && tectonicState) {
    overlay.mountainCount =
      (tectonicState.orogenBelts?.length ?? 0) +
      (tectonicState.mountainRidges?.length ?? 0);
    overlay.basinCount = tectonicState.landRifts?.length ?? 0;
  }
  if (baseLayer === "crust" && tectonicState) {
    const land = tectonicState.plates.filter((p) => p.continental).length;
    overlay.oceanPlateCount = tectonicState.plates.length - land;
  }
  overlay.simTimeDays = climateTimeDays;
  overlay.ecologyDay = ecologyDay;
  overlay.ecologySummary = ecologyPoolSummary(layer.cells);
  overlay.climateSummary = climateSummary(
    layer.cells,
    climateTimeDays,
    layer.geoFrame?.planet
  );
  return overlay;
}

function refreshMapInfoPanel(): void {
  const info = buildMapInfoData();
  if (info) updateMapInfoPanel(mapInfoEl, info);
}

function draw(): void {
  if (!layer || cssW === 0) return;

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(terrainCache, 0, 0, cssW, cssH);

  if (elementOverlays.length > 0) {
    renderElementOverlays(
      ctx,
      layer,
      cssW,
      cssH,
      elementOverlays,
      currentZoom(),
      panX,
      panY
    );
  }

  const isClimateLayer = baseLayer === "climate";
  const isMeteoMap = isClimateLayer && climateUi.scalarLayer === "satelliteCloud";
  const isPressureLayer =
    isClimateLayer &&
    (climateUi.scalarLayer === "pressure" || climateUi.displayMode === "merged");
  const showCyclones = isMeteoMap || isPressureLayer;

  if (cloudParams.enabled && !isClimateLayer) {
    renderCycloneOverlay(
      ctx,
      layer,
      cssW,
      cssH,
      currentZoom(),
      panX,
      panY,
      cloudParams.coverage
    );
  }

  if (baseLayer === "climate") {
    const contourLayer =
      climateUi.displayMode === "merged" ? "pressure" : climateUi.scalarLayer;
    if (
      climateUi.displayMode === "layered" &&
      climateUi.scalarLayer !== "satelliteCloud"
    ) {
      renderClimateContourOverlay(
        ctx,
        layer,
        contourLayer,
        cssW,
        cssH,
        currentZoom(),
        panX,
        panY
      );
    }
    // 气候层叠加地形等高线（默认海岸线，可选全等高线）
    const terrainContour: TerrainContourMode = showHeightContours
      ? "full"
      : showCoastline
        ? "coastline"
        : "none";
    if (terrainContour !== "none") {
      renderTerrainContourOverlay(
        ctx,
        layer,
        cssW,
        cssH,
        terrainContour,
        currentZoom(),
        panX,
        panY,
        true
      );
    }
    renderClimateWindField(
      ctx,
      layer,
      cloudParams,
      cssW,
      cssH,
      currentZoom(),
      panX,
      panY
    );
  }

  if (showCyclones) {
    renderCycloneOverlay(ctx, layer, cssW, cssH, currentZoom(), panX, panY, 1, isMeteoMap);
  }

  // 高度/构造/地质层：默认仅海岸线；勾选后显示全海拔等高线
  const heightContourBase =
    baseLayer === "height" || baseLayer === "structure" || baseLayer === "geology";
  if (heightContourBase && elementOverlays.length === 0) {
    const mode: TerrainContourMode = showHeightContours
      ? "full"
      : showCoastline
        ? "coastline"
        : "none";
    if (mode !== "none") {
      renderTerrainContourOverlay(ctx, layer, cssW, cssH, mode, currentZoom(), panX, panY);
    }
  }

  const stats = heightStats(layer.cells);
  renderMapRulers(ctx, layer, cssW, cssH, {
    zoom: currentZoom(),
    panX,
    panY,
    showHeightScale: baseLayer === "height" || elementOverlays.length > 0,
    heightMin: stats.min,
    heightMax: stats.max,
    maxHeight: terrainParams.maxHeight,
  });

  if (regionPickMode && isPlanetLayer(layer)) {
    renderRegionGridOverlay(
      ctx,
      layer,
      cssW,
      cssH,
      currentZoom(),
      panX,
      panY,
      hoverRegion,
      generatedRegionKeys(worldSave)
    );
  }

  refreshMapInfoPanel();
}

function tickWorld(dtDays: number, atDay = climateTimeDays): void {
  if (!layer || dtDays <= 0) return;
  tickClimateFrame(layer.cells, dtDays, {
    bounds: layer.bounds,
    day: atDay,
    cloud: cloudParams,
    worldSeed: terrainParams.seed,
  });
  climateTimeDays = atDay + dtDays;
  ecologyDay = Math.floor(climateTimeDays);
  if (layer.geoFrame) layer.geoFrame.clock.simDay = climateTimeDays;
}

/** 分帧推进，避免 100 年等大批量计算冻结 UI */
function runClimateAsync(
  totalDays: number,
  onComplete: (days: number) => void
): void {
  if (!layer || totalDays <= 0 || simBusy) return;

  if (totalDays <= 31) {
    tickWorld(totalDays);
    finishAdvance(`气候+生态推进 ${totalDays} 天`, false);
    return;
  }

  simBusy = true;
  const stepDays = climateStepDaysForSpan(totalDays);
  const stepsPerFrame = totalDays > 3650 ? 80 : 35;
  let processed = 0;

  setControlStatus(`气候推进中… 0%`);

  function frame(): void {
    if (!layer) {
      simBusy = false;
      return;
    }

    let budget = stepsPerFrame;
    while (budget > 0 && processed < totalDays) {
      const step = Math.min(stepDays, totalDays - processed);
      tickClimateStep(layer.cells, step, {
        bounds: layer.bounds,
        day: climateTimeDays + processed,
        cloud: cloudParams,
        worldSeed: terrainParams.seed,
      });
      processed += step;
      budget--;
    }

    const pct = Math.round((processed / totalDays) * 100);
    setControlStatus(`气候推进中… ${pct}%（${processed}/${totalDays} 天）`);

    if (processed < totalDays) {
      rebuildTerrainCache();
      draw();
      requestAnimationFrame(frame);
    } else {
      simBusy = false;
      onComplete(totalDays);
    }
  }

  requestAnimationFrame(frame);
}

function finishAdvance(label: string, addDays = true, days = 0): void {
  if (!layer) return;
  if (addDays) climateTimeDays += days;
  ecologyDay = Math.floor(climateTimeDays);
  rebuildTerrainCache();
  draw();
  updateMetricsCharts();
  setControlStatus(`${label} · ${formatSimTime(climateTimeDays)}`);
  setSimTimeDisplay(climateTimeDays);
}

function formatSimTime(day: number): string {
  const hour = ((day % 1) + 1) % 1 * 24;
  const hh = Math.floor(hour);
  const mm = Math.floor((hour - hh) * 60);
  return `第 ${Math.floor(day)} 天 ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}


function advanceSimStep(unit: SimAdvanceUnit): void {
  if (!layer || simBusy) return;
  const days = simUnitToDays(unit);
  const wholeYears = Math.floor(days / 365);
  const label = SIM_ADVANCE_SPECS.find((s) => s.id === unit)?.label ?? unit;

  if (days <= 31) {
    tickWorld(days);
    if (wholeYears > 0) tickEcologyYear(layer.cells, wholeYears);
    finishAdvance(`步进 +${label}`, false);
    return;
  }

  runClimateAsync(days, () => {
    if (wholeYears > 0) tickEcologyYear(layer.cells, wholeYears);
    finishAdvance(`步进 +${label}`, true, days);
  });
}

function loop(ts: number): void {
  if (!lastTs) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.2) dt = 0.2;

  if (ecologyParams.playing && layer && !simBusy) {
    const hoursPerSec = simUnitHours(ecologyParams.playSpeed);
    const dtDays = (hoursPerSec * dt) / 24;
    if (dtDays > 0) {
      const prevYear = Math.floor(climateTimeDays / 365);
      tickWorld(dtDays, climateTimeDays);
      const yearsCrossed = Math.floor(climateTimeDays / 365) - prevYear;
      if (yearsCrossed > 0) tickEcologyYear(layer.cells, yearsCrossed);
      climateCacheFrame++;
      if (baseLayer !== "climate" || climateCacheFrame % 2 === 0) {
        rebuildTerrainCache();
      }
      draw();
      setSimTimeDisplay(climateTimeDays);
    }
  }

  requestAnimationFrame(loop);
}

let prevTerrainParams: TerrainParams = { ...DEFAULT_TERRAIN };

buildLayer(DEFAULT_TERRAIN.seed);

controlState = mountControls(
  controlsEl,
  {
    onTerrainChange: (params) => {
      handleTerrainChange(params);
    },
    onRandomSeed: () => {
      const newSeed = Math.floor(Math.random() * 1_000_000);
      setControlSeed(controlState, newSeed);
      terrainParams.seed = newSeed;
      prevTerrainParams = { ...terrainParams };
      buildLayer(newSeed);
    },
    onSaveWorld: () => finalizeWorldSave(),
    onOpenRegionPicker: () => toggleRegionPickMode(),
    onReturnPlanet: () => returnToPlanet(),
    onFlatOceanChange: (flat) => {
      flatOcean = flat;
      rebuildTerrainCache();
      draw();
    },
    onHeightContoursChange: (show) => {
      showHeightContours = show;
      draw();
    },
    onCoastlineChange: (show) => {
      showCoastline = show;
      draw();
    },
    onCloudChange: (cloud) => {
      cloudParams = { ...cloud };
      if (layer) {
        buildMeteoFields(layer.cells, layer.bounds, climateTimeDays);
      }
      draw();
    },
    onClimateUiChange: (ui) => {
      climateUi = { ...ui };
      if (baseLayer === "climate") {
        rebuildTerrainCache();
        draw();
      }
    },
    onBaseLayerChange: (layerName) => {
      baseLayer = layerName;
      setControlStatus(`切换至 ${displayModeLabel(layerName)}…`);
      scheduleLayerRedraw();
      refreshMapInfoPanel();
    },
    onElementOverlaysChange: (keys) => {
      elementOverlays = keys;
      rebuildTerrainCache();
      draw();
    },
    onMetricsUiChange: (ui) => {
      metricsUi = { ...ui };
      updateMetricsCharts();
    },
    onHeightColorScaleChange: (scale) => {
      setHeightColorScale(scale);
      rebuildTerrainCache();
      draw();
    },
    onZoomStep: (delta) => {
      const next = zoomIndex + delta;
      if (next < 0 || next >= ZOOM_LEVELS.length) return;
      zoomIndex = next;
      refreshView();
    },
    onPanStep: (dir) => {
      const step = Math.min(cssW, cssH) * 0.12;
      switch (dir) {
        case "left":
          panX += step;
          break;
        case "right":
          panX -= step;
          break;
        case "up":
          panY += step;
          break;
        case "down":
          panY -= step;
          break;
      }
      refreshView();
    },
    onPanReset: () => {
      panX = 0;
      panY = 0;
      refreshView();
    },
    onEcologyChange: (ecology) => {
      ecologyParams = { ...ecology };
    },
    onSimStep: (unit) => {
      advanceSimStep(unit);
    },
  },
  DEFAULT_TERRAIN,
  DEFAULT_CLOUD,
  DEFAULT_ECOLOGY
);

setViewDisplay(zoomIndex);

let dragging = false;
let lastPointer = { x: 0, y: 0 };

canvas.style.cursor = "grab";
canvas.style.touchAction = "none";

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (regionPickMode) return;
  dragging = true;
  lastPointer = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (e) => {
  if (regionPickMode && layer && isPlanetLayer(layer)) {
    const pick = pickRegionAtScreen(e.clientX, e.clientY);
    if (
      pick?.col !== hoverRegion?.col ||
      pick?.row !== hoverRegion?.row
    ) {
      hoverRegion = pick;
      if (pick) setControlStatus(regionStatusText(worldSave, pick.col, pick.row));
      draw();
    }
    return;
  }
  if (!dragging) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  lastPointer = { x: e.clientX, y: e.clientY };
  panX += dx;
  panY += dy;
  applyViewClamp();
  rebuildTerrainCache();
  draw();
});

function endDrag(e: PointerEvent): void {
  if (regionPickMode) {
    const pick = pickRegionAtScreen(e.clientX, e.clientY);
    if (pick) drillDownRegion(pick.col, pick.row);
    return;
  }
  if (!dragging) return;
  dragging = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
  canvas.style.cursor = "grab";
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && regionPickMode) {
    setRegionPickMode(false);
    setControlStatus("已取消选区");
  }
});

function setMetricsPanelOpen(open: boolean): void {
  metricsShell.classList.toggle("collapsed", !open);
  metricsToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    metricsToggle.textContent = "◀";
    metricsToggle.title = "向左折叠计量图";
    requestAnimationFrame(() => updateMetricsCharts());
  } else {
    metricsToggle.textContent = "计量图";
    metricsToggle.title = "展开计量图";
  }
}

window.addEventListener("resize", resizeCanvas);
metricsToggle.addEventListener("click", () => {
  setMetricsPanelOpen(metricsShell.classList.contains("collapsed"));
});
resizeCanvas();
requestAnimationFrame(loop);

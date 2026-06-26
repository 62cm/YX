import type {
  BaseLayer,
  ClimateScalarLayer,
  ClimateUiState,
  CloudParams,
  EcologyParams,
  SimAdvanceUnit,
  ElementKey,
  TerrainParams,
} from "./types";
import {
  CLIMATE_SCALAR_LAYERS,
  DEFAULT_CLIMATE_UI,
  DEFAULT_CLOUD,
  DEFAULT_ECOLOGY,
  DEFAULT_TERRAIN,
  ELEMENT_KEYS,
  SIM_PLAY_UNITS,
  SIM_ADVANCE_SPECS,
  simPlayRateLabel,
  simUnitShortLabel,
  simPlaySpeedIndex,
  simPlaySpeedFromIndex,
  ELEMENTS,
  GEOLOGY,
  GEOLOGY_KINDS,
  SURFACE,
  SURFACE_KINDS,
  VEGETATION,
  VEGETATION_KINDS,
  VEIN_RULES,
} from "./types";
import { DEFAULT_ZOOM_INDEX, formatZoomLevel, ZOOM_LEVELS, type HeightColorScale } from "./render";
import { METRIC_DIMENSIONS, type MetricDimension, type MetricScope } from "./metrics";

function veinDensityLabel(d: number): string {
  const pct = Math.round(d * 100);
  if (pct <= 33) return `${pct}% · 分散贫矿`;
  if (pct >= 67) return `${pct}% · 密集富矿`;
  return `${pct}% · 中等`;
}

function renderGeologyLegend(): string {
  return GEOLOGY_KINDS.map((k) => {
    const g = GEOLOGY[k];
    return `
      <details class="geo-detail">
        <summary class="legend-item">
          <span class="legend-swatch" style="background:${g.color}"></span>
          ${g.name}
        </summary>
        <div class="geo-detail-body">
          <p><span class="detail-label">成因</span>${g.origin}</p>
          <p><span class="detail-label">高度</span>${g.heightNote}</p>
          <p><span class="detail-label">矿脉</span>${g.veins}</p>
          <p><span class="detail-label">发展</span>${g.development}</p>
        </div>
      </details>`;
  }).join("");
}

function renderElementChecks(): string {
  return ELEMENT_KEYS.map(
    (k) => `
      <label class="element-check">
        <input type="checkbox" class="element-overlay-cb" value="${k}" />
        <span class="legend-swatch" style="background:${ELEMENTS[k].color}"></span>
        <span>${ELEMENTS[k].name} ${k}</span>
        <span class="element-cat">${ELEMENTS[k].category}</span>
      </label>`
  ).join("");
}

function renderSurfaceLegend(): string {
  return SURFACE_KINDS.map((k) => {
    const s = SURFACE[k];
    return `
      <details class="geo-detail">
        <summary class="legend-item">
          <span class="legend-swatch" style="background:${s.color}"></span>
          ${s.name}
        </summary>
        <div class="geo-detail-body">
          <p><span class="detail-label">物性</span>${s.effects}</p>
        </div>
      </details>`;
  }).join("");
}

function renderVegetationLegend(): string {
  return VEGETATION_KINDS.filter((k) => k !== "none").map((k) => {
    const v = VEGETATION[k];
    return `
      <details class="geo-detail">
        <summary class="legend-item">
          <span class="legend-swatch" style="background:${v.color}"></span>
          ${v.name}
        </summary>
        <div class="geo-detail-body">
          <p><span class="detail-label">生态</span>${v.effects}</p>
        </div>
      </details>`;
  }).join("");
}

function renderVeinLegend(): string {
  return VEIN_RULES.map((r) => {
    const el = ELEMENTS[r.element];
    const geo = GEOLOGY[r.geology];
    return `
      <details class="vein-detail">
        <summary class="legend-item">
          <span class="legend-swatch vein-el-swatch" style="background:${el.color}" title="${el.name}"></span>
          <span class="legend-swatch vein-geo-swatch" style="background:${geo.color}" title="${geo.name}"></span>
          ${geo.name} · ${r.oreName}
        </summary>
        <div class="geo-detail-body">
          <p><span class="detail-label">元素</span>${el.name} ${r.element}（${el.category}）</p>
          <p><span class="detail-label">色标</span>左=元素层热图色 · 右=所属地质色</p>
          <p><span class="detail-label">说明</span>${r.note}</p>
        </div>
      </details>`;
  }).join("");
}

export interface MetricsUiState {
  dimension: MetricDimension;
  scope: MetricScope;
  profileAxis: "x" | "y";
}

export interface ControlCallbacks {
  onTerrainChange: (params: TerrainParams) => void;
  /** 侧栏状态行（计算中/完成） */
  onStatus?: (message: string) => void;
  onRandomSeed: () => void;
  onSaveWorld?: () => void;
  onOpenRegionPicker?: () => void;
  onReturnPlanet?: () => void;
  onFlatOceanChange: (flat: boolean) => void;
  onCoastlineChange?: (show: boolean) => void;
  onHeightContoursChange: (show: boolean) => void;
  onCloudChange: (cloud: CloudParams) => void;
  onEcologyChange?: (ecology: EcologyParams) => void;
  onSimStep?: (unit: SimAdvanceUnit) => void;
  onClimateUiChange?: (ui: ClimateUiState) => void;
  onBaseLayerChange: (layer: BaseLayer) => void;
  onElementOverlaysChange: (keys: ElementKey[]) => void;
  onMetricsUiChange?: (ui: MetricsUiState) => void;
  onHeightColorScaleChange?: (scale: HeightColorScale) => void;
  onZoomStep: (delta: -1 | 1) => void;
  onPanStep: (dir: "up" | "down" | "left" | "right") => void;
  onPanReset: () => void;
}

export function displayModeLabel(base: BaseLayer, overlays: ElementKey[] = []): string {
  const labels: Record<BaseLayer, string> = {
    height: "高度",
    geology: "地质结构",
    structure: "构造(点线面)",
    crust: "地壳(陆/洋)",
    dominant: "主导元素(资源)",
    surface: "地表",
    water: "水体",
    climate: "气候生态",
  };
  const baseLabel = labels[base];
  if (overlays.length === 0) return baseLabel;
  const names = overlays.map((k) => `${ELEMENTS[k].name}${k}`).join("·");
  return `${baseLabel} + α[${names}]`;
}

export interface ControlState {
  terrain: TerrainParams;
  cloud: CloudParams;
  ecology: EcologyParams;
  climate: ClimateUiState;
}

export function mountControls(
  container: HTMLElement,
  callbacks: ControlCallbacks,
  initial: TerrainParams = DEFAULT_TERRAIN,
  initialCloud: CloudParams = DEFAULT_CLOUD,
  initialEcology: EcologyParams = DEFAULT_ECOLOGY,
  initialClimate: ClimateUiState = DEFAULT_CLIMATE_UI
): ControlState {
  const state: ControlState = {
    terrain: { ...initial },
    cloud: { ...initialCloud },
    ecology: { ...initialEcology },
    climate: { ...initialClimate },
  };

  const elementChecks = renderElementChecks();
  const geologyLegend = renderGeologyLegend();
  const surfaceLegend = renderSurfaceLegend();
  const vegetationLegend = renderVegetationLegend();
  const veinLegend = renderVeinLegend();
  const veinPct = Math.round(initial.veinDensity * 100);
  const metricDimOptions = METRIC_DIMENSIONS.map(
    (d) => `<option value="${d.id}">${d.label}</option>`
  ).join("");
  const climateScalarOptions = CLIMATE_SCALAR_LAYERS.map(
    (d) =>
      `<option value="${d.id}" ${d.id === initialClimate.scalarLayer ? "selected" : ""}>${d.label}</option>`
  ).join("");
  const initialSpeedIdx = simPlaySpeedIndex(initialEcology.playSpeed);
  const simSpeedTicks = SIM_PLAY_UNITS.map((u) => `<span>${simUnitShortLabel(u)}</span>`).join("");
  const simStepButtons = SIM_ADVANCE_SPECS.map(
    (s) =>
      `<button type="button" class="sim-step-btn" data-sim-step="${s.id}" title="+${s.label}">+${simUnitShortLabel(s.id)}</button>`
  ).join("");

  container.innerHTML = `
    <div class="control-group">
      <label>显示层</label>
      <div class="layer-tabs layer-tabs-wrap" role="tablist">
        <button type="button" class="layer-tab active" data-layer="height" role="tab">高度</button>
        <button type="button" class="layer-tab" data-layer="geology" role="tab">地质</button>
        <button type="button" class="layer-tab" data-layer="structure" role="tab">构造</button>
        <button type="button" class="layer-tab" data-layer="crust" role="tab">地壳</button>
        <button type="button" class="layer-tab" data-layer="dominant" role="tab">主导</button>
        <button type="button" class="layer-tab" data-layer="surface" role="tab">地表</button>
        <button type="button" class="layer-tab" data-layer="water" role="tab">水体</button>
        <button type="button" class="layer-tab" data-layer="climate" role="tab">气候</button>
      </div>
    </div>

    <details class="section" id="element-overlay-section">
      <summary>元素成分层（勾选 α 叠加）</summary>
      <div class="section-body">
        <p class="vein-intro">
          <strong>主导</strong>：每格资源元素（C/H/N/Fe/Ca/Na）中最高者；O/Si 为基质不参与。
          <strong>勾选</strong>：灰阶陆地+海岸线，仅富集格填色。
        </p>
        <div class="element-checks">${elementChecks}</div>
      </div>
    </details>
    <div class="control-group">
      <label>地图缩放</label>
      <div class="stepper-row">
        <button type="button" id="zoom-out" aria-label="缩小">◀</button>
        <span class="stepper-value" id="zoom-value">${formatZoomLevel(ZOOM_LEVELS[DEFAULT_ZOOM_INDEX])}</span>
        <button type="button" id="zoom-in" aria-label="放大">▶</button>
      </div>
      <div class="hint">0.1 · 0.2 · 0.5 · 0.75 · 1 · 1.5 · 2 · 4 · 8 · 16 · 32 · 64×</div>
      <label class="checkbox-label" style="margin-top:0.5rem">
        <input type="checkbox" id="show-coastline" checked />
        海岸线（海拔 0 m）
      </label>
      <label class="checkbox-label" style="margin-top:0.35rem">
        <input type="checkbox" id="show-height-contours" />
        海拔等高线（陆地粗白 · 海洋细蓝）
      </label>
    </div>
    <div class="control-group">
      <label>地图平移</label>
      <div class="pan-pad">
        <button type="button" class="pan-btn" id="pan-up" aria-label="向上">↑</button>
        <div class="pan-mid">
          <button type="button" class="pan-btn" id="pan-left" aria-label="向左">←</button>
          <button type="button" class="pan-btn pan-reset" id="pan-reset" title="居中">◎</button>
          <button type="button" class="pan-btn" id="pan-right" aria-label="向右">→</button>
        </div>
        <button type="button" class="pan-btn" id="pan-down" aria-label="向下">↓</button>
      </div>
      <div class="hint">放大后在画布上按住拖动，或用方向键平移</div>
    </div>

    <details class="section" id="terrain-section">
      <summary>地形参数 · 滑块</summary>
      <div class="section-body">
        <div class="control-group">
          <label for="height-slider">最高高度 (m，大陆最高处)</label>
          <input type="range" id="height-slider" min="500" max="10000" step="100" value="${initial.maxHeight}" />
          <div class="value" id="height-value">${initial.maxHeight} m</div>
        </div>
        <div class="control-group">
          <label for="decay-slider">陆块聚集度 (超大陆聚集 ← → 岛屿离散)</label>
          <input type="range" id="decay-slider" min="0" max="100" step="1" value="${Math.round(initial.decay * 100)}" />
          <div class="value" id="decay-value">${Math.round(initial.decay * 100)}%</div>
          <div class="hint">低=陆核靠拢成超大陆；高=陆块分散碎裂</div>
        </div>
        <div class="control-group">
          <label for="local-decay-slider">海岸细节 (平滑 ← → 粗糙 fBm)</label>
          <input type="range" id="local-decay-slider" min="0" max="100" step="1" value="${Math.round(initial.localDecay * 100)}" />
          <div class="value" id="local-decay-value">${Math.round(initial.localDecay * 100)}%</div>
          <div class="hint">LEM 后海岸 fBm 细节；较快重算</div>
        </div>
        <div class="control-group">
          <label for="edge-smooth-slider">维诺边缘平滑 (格网棱角 ← → 圆滑融合)</label>
          <input type="range" id="edge-smooth-slider" min="0" max="100" step="1" value="${Math.round(initial.edgeSmooth * 100)}" />
          <div class="value" id="edge-smooth-value">${Math.round(initial.edgeSmooth * 100)}%</div>
          <div class="hint">~10000 格 / 40000×20000 km 行星图，单格约数十 km。混合邻格高度，削弱蜂窝海岸线</div>
        </div>
        <div class="control-group">
          <label for="continent-slider">大陆块数 (陆核/克拉通)</label>
          <input type="range" id="continent-slider" min="1" max="12" step="1" value="${initial.continentCount}" />
          <div class="value" id="continent-value">${initial.continentCount}</div>
          <div class="hint">另自动补足洋壳板块（约为大陆的 75%+1），构造层可辨陆/洋</div>
        </div>
        <div class="control-group">
          <label class="checkbox-label">
            <input type="checkbox" id="single-continent" ${initial.singleContinent ? "checked" : ""} />
            单一大陆（仅 1 个陆核/陆壳板块）
          </label>
          <label class="checkbox-label">
            <input type="checkbox" id="ocean-ring" ${initial.oceanRing ? "checked" : ""} />
            强制环海（边缘带压低为海，避免贴边裁切）
          </label>
        </div>
        <div class="control-row">
          <label for="tectonic-slider">共演化迭代</label>
          <input type="range" id="tectonic-slider" min="2" max="12" step="1" value="${initial.tectonicIterations}" />
          <div class="value" id="tectonic-value">${initial.tectonicIterations}</div>
        </div>
        <div class="control-group">
          <label for="mesh-uniformity-slider">格网均匀化 (构造挤压 ← → 等面积)</label>
          <input type="range" id="mesh-uniformity-slider" min="0" max="100" step="1" value="${Math.round(initial.meshUniformity * 100)}" />
          <div class="value" id="mesh-uniformity-value">${Math.round(initial.meshUniformity * 100)}%</div>
          <div class="hint">越高格子越均匀；越低构造带旁越细。共演化前重置格网，避免巨格累积</div>
        </div>
        <div class="control-group">
          <label for="land-centric-slider">陆地居中 (均匀撒点 ← → 中心陆核+边缘海)</label>
          <input type="range" id="land-centric-slider" min="0" max="100" step="1" value="${Math.round(initial.landCentric * 100)}" />
          <div class="value" id="land-centric-value">${Math.round(initial.landCentric * 100)}%</div>
          <div class="hint">陆核偏画布中心、洋壳偏外缘；边缘带趋海，减少「贴边局部图」感</div>
        </div>
        <div class="control-group">
          <label for="mountain-slider">活动陆缘造山强度</label>
          <input type="range" id="mountain-slider" min="0" max="15" step="1" value="${initial.mountainCount}" />
          <div class="value" id="mountain-value">${initial.mountainCount}</div>
          <div class="hint">仅放大门控后的造山幅值，不增加弱汇聚边界</div>
        </div>
        <div class="control-group">
          <label for="basin-slider">大陆裂谷/盆地强度</label>
          <input type="range" id="basin-slider" min="0" max="15" step="1" value="${initial.basinCount}" />
          <div class="value" id="basin-value">${initial.basinCount}</div>
          <div class="hint">陆壳离散边界沉降；冰区裂谷自动填冰</div>
        </div>
        <div class="control-group">
          <label for="ocean-slider">海洋比例 (洋壳/陆壳面积比)</label>
          <input type="range" id="ocean-slider" min="0" max="100" step="1" value="${Math.round(initial.oceanRatio * 100)}" />
          <div class="value" id="ocean-value">${Math.round(initial.oceanRatio * 100)}%</div>
        </div>
        <div class="control-group">
          <label class="checkbox-label">
            <input type="checkbox" id="flat-ocean" />
            海洋平铺为双色（浅海/深海，看清大陆边界）
          </label>
        </div>
        <div class="control-group seed-group">
          <label>世界种子</label>
          <div class="seed-row">
            <code id="seed-display">${initial.seed}</code>
            <button type="button" id="btn-seed">随机新种子</button>
          </div>
          <div class="hint">种子决定维诺格网形状 + 地形/矿脉随机布局；换种子 = 换一张新世界。</div>
        </div>
        <div class="control-group world-save-group">
          <label>世界存档 · 下钻</label>
          <div class="seed-row">
            <button type="button" id="btn-save-world">存档全球</button>
            <button type="button" id="btn-pick-region">在地图上选片区</button>
          </div>
          <button type="button" id="btn-return-planet" class="full-width-btn" disabled>返回全球图</button>
          <div class="hint">全球图生成后点「在地图上选片区」，直接在主地图点击 1000×1000 km 块下钻（Esc 取消）。</div>
        </div>
      </div>
    </details>

    <details class="section" id="geology-legend-section">
      <summary>地质结构 · 图例与说明</summary>
      <div class="section-body geology-legend">
        ${geologyLegend}
      </div>
    </details>

    <details class="section" id="surface-legend-section">
      <summary>地表基质 · 图例与物性</summary>
      <div class="section-body geology-legend">
        <p class="vein-intro">
          岩石/土壤/冰等基质，不含植被。由地质、水、氧化还原与纬度派生；植被单独叠色显示。
        </p>
        ${surfaceLegend}
      </div>
    </details>

    <details class="section" id="vegetation-legend-section">
      <summary>植被覆盖 · 图例</summary>
      <div class="section-body geology-legend">
        <p class="vein-intro">
          叠在基质之上：湿润区森林/草地，干旱区灌木，冻土苔藓。火山岩、冰盖、裸岩无植被。
        </p>
        ${vegetationLegend}
      </div>
    </details>

    <details class="section" id="vein-section">
      <summary>矿脉 · 元素富集</summary>
      <div class="section-body">
        <p class="vein-intro">
          因果：地质决定<strong>哪些元素、哪片区域</strong>可能有矿；
          富集度滑块只调节<strong>分散贫矿 ↔ 密集富矿</strong>，不改变地质归属。
          火山格走专属铁矿，不与造山带重复叠加。
        </p>
        <div class="control-group">
          <label for="vein-density-slider">矿脉富集度 (分散贫矿 ← → 密集富矿)</label>
          <input type="range" id="vein-density-slider" min="0" max="100" step="1" value="${veinPct}" />
          <div class="value" id="vein-density-value">${veinDensityLabel(initial.veinDensity)}</div>
          <div class="hint">左：矿点多、范围大、单点弱 · 右：矿点少、范围小、单点强</div>
        </div>
        <div class="legend-title">矿脉色标（左=元素热图色 · 右=地质色，点击展开）</div>
        <div class="vein-legend">${veinLegend}</div>
        <p class="hint">勾选「元素成分层」中的元素（如铁 Fe、碳 C）可叠加矿脉富集热点。</p>
      </div>
    </details>

    <details class="section" id="cloud-section">
      <summary>气旋云系 · 显示</summary>
      <div class="section-body">
        <p class="vein-intro">在<strong>非气候层</strong>叠加卫星云图风格气旋螺旋（由模拟演算，风向风速不可手动调节）。气候层请用「气象图」分层。</p>
        <div class="control-group">
          <label class="checkbox-label">
            <input type="checkbox" id="cloud-enabled" ${initialCloud.enabled ? "checked" : ""} />
            显示气旋云系
          </label>
        </div>
        <div class="control-group">
          <label for="cloud-cover">螺旋云带亮度</label>
          <input type="range" id="cloud-cover" min="0" max="100" step="1" value="${Math.round(initialCloud.coverage * 100)}" />
          <div class="value" id="cloud-cover-value">${Math.round(initialCloud.coverage * 100)}%</div>
        </div>
      </div>
    </details>

    <details class="section" id="climate-section">
      <summary>气候显示 · 合并 / 分层</summary>
      <div class="section-body">
        <p class="vein-intro">合并图叠等压线并随昼夜变暗；分层默认「气象图」：低压偏蓝、高压偏暖、绿色降水，气旋为卫星螺旋云图。</p>
        <div class="control-group">
          <label>显示模式</label>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            <label class="checkbox-label">
              <input type="radio" name="climate-display" id="climate-merged" value="merged" ${initialClimate.displayMode === "merged" ? "checked" : ""} />
              合并显示
            </label>
            <label class="checkbox-label">
              <input type="radio" name="climate-display" id="climate-layered" value="layered" ${initialClimate.displayMode === "layered" ? "checked" : ""} />
              分层显示
            </label>
          </div>
        </div>
        <div class="control-group" id="climate-scalar-group">
          <label for="climate-scalar">分层变量</label>
          <select id="climate-scalar">${climateScalarOptions}</select>
        </div>
      </div>
    </details>

    <details class="section" id="ecology-section">
      <summary>模拟推进 · 气候 + 生态</summary>
      <div class="section-body">
        <p class="vein-intro">
          默认<strong>暂停</strong>。勾选自动播放后按所选档位推进模拟时间（气旋移动、昼夜、温压风、植被）。步进按钮可一次性跳跃。
        </p>
        <div class="control-group">
          <label class="checkbox-label">
            <input type="checkbox" id="ecology-play" ${initialEcology.playing ? "checked" : ""} />
            自动播放
          </label>
        </div>
        <div class="control-group">
          <label for="sim-speed-slider">播放速度 <span class="sim-speed-current" id="ecology-speed-value">${simPlayRateLabel(initialEcology.playSpeed)}</span></label>
          <div class="sim-speed-rail">
            <input type="range" id="sim-speed-slider" min="0" max="${SIM_PLAY_UNITS.length - 1}" step="1" value="${initialSpeedIdx}" />
            <div class="sim-speed-ticks" aria-hidden="true">${simSpeedTicks}</div>
          </div>
        </div>
        <div class="control-group">
          <div class="value" id="ecology-day-value">模拟 第 0 天 00:00</div>
        </div>
        <div class="control-group">
          <label>步进</label>
          <div class="sim-step-row">${simStepButtons}</div>
        </div>
      </div>
    </details>

    <details class="section" id="metrics-section" open>
      <summary>计量图 · 分布检查</summary>
      <div class="section-body">
        <div class="control-group">
          <label for="metric-dim">计量维度</label>
          <select id="metric-dim">${metricDimOptions}</select>
        </div>
        <div class="control-group">
          <label for="metric-scope">统计范围</label>
          <select id="metric-scope">
            <option value="land" selected>大陆（高度 ≥ 0）</option>
            <option value="full">全域（含负高度海域）</option>
          </select>
        </div>
        <div class="control-group">
          <label for="profile-axis">剖面热图轴</label>
          <select id="profile-axis">
            <option value="x" selected>横向 X (km)</option>
            <option value="y">纵向 Y (km)</option>
          </select>
        </div>
        <div class="control-group">
          <label for="height-scale">高度色标</label>
          <select id="height-scale">
            <option value="balanced" selected>均衡（默认·中间灰阶）</option>
            <option value="linear">线性（绝对米）</option>
            <option value="log">对数</option>
          </select>
          <div class="hint">均衡：500m 浅肉 · 2km 中灰 · 5km 深肉 · 10km 黑</div>
        </div>
        <div class="hint">
          左栏整列可向左折叠（◀ 按钮）；① 强度→面积 ② 抖动 ③ 剖面热图
        </div>
      </div>
    </details>

    <div id="legend">
      <div>构造层折线：红橙=山脊/造山带 · 紫=陆陆裂谷 · 蓝实线=海沟 · 蓝虚线=洋中脊（仅海底）</div>
      <div>高度色标默认均衡：0m 白 · 常见海拔落肉色灰阶 · 10000m 黑</div>
      <div class="legend-bar"></div>
    </div>
    <div id="status">就绪</div>
  `;

  const heightSlider = container.querySelector<HTMLInputElement>("#height-slider")!;
  const decaySlider = container.querySelector<HTMLInputElement>("#decay-slider")!;
  const localDecaySlider = container.querySelector<HTMLInputElement>("#local-decay-slider")!;
  const edgeSmoothSlider = container.querySelector<HTMLInputElement>("#edge-smooth-slider")!;
  const continentSlider = container.querySelector<HTMLInputElement>("#continent-slider")!;
  const singleContinentCb = container.querySelector<HTMLInputElement>("#single-continent")!;
  const oceanRingCb = container.querySelector<HTMLInputElement>("#ocean-ring")!;
  const tectonicSlider = container.querySelector<HTMLInputElement>("#tectonic-slider")!;
  const meshUniformitySlider = container.querySelector<HTMLInputElement>("#mesh-uniformity-slider")!;
  const landCentricSlider = container.querySelector<HTMLInputElement>("#land-centric-slider")!;
  const mountainSlider = container.querySelector<HTMLInputElement>("#mountain-slider")!;
  const basinSlider = container.querySelector<HTMLInputElement>("#basin-slider")!;
  const oceanSlider = container.querySelector<HTMLInputElement>("#ocean-slider")!;
  const veinDensitySlider = container.querySelector<HTMLInputElement>("#vein-density-slider")!;
  const zoomOutBtn = container.querySelector<HTMLButtonElement>("#zoom-out")!;
  const zoomInBtn = container.querySelector<HTMLButtonElement>("#zoom-in")!;
  const heightValue = container.querySelector("#height-value")!;
  const decayValue = container.querySelector("#decay-value")!;
  const localDecayValue = container.querySelector("#local-decay-value")!;
  const edgeSmoothValue = container.querySelector("#edge-smooth-value")!;
  const continentValue = container.querySelector("#continent-value")!;
  const tectonicValue = container.querySelector("#tectonic-value")!;
  const meshUniformityValue = container.querySelector("#mesh-uniformity-value")!;
  const landCentricValue = container.querySelector("#land-centric-value")!;
  const mountainValue = container.querySelector("#mountain-value")!;
  const basinValue = container.querySelector("#basin-value")!;
  const oceanValue = container.querySelector("#ocean-value")!;
  const veinDensityValue = container.querySelector("#vein-density-value")!;
  const seedDisplay = container.querySelector("#seed-display")!;
  const statusEl = container.querySelector("#status")!;

  function emitTerrain() {
    callbacks.onTerrainChange({ ...state.terrain });
    statusEl.textContent = "地形已更新";
  }

  heightSlider.addEventListener("input", () => {
    state.terrain.maxHeight = Number(heightSlider.value);
    heightValue.textContent = `${state.terrain.maxHeight} m`;
    emitTerrain();
  });

  decaySlider.addEventListener("input", () => {
    state.terrain.decay = Number(decaySlider.value) / 100;
    decayValue.textContent = `${decaySlider.value}%`;
    emitTerrain();
  });

  localDecaySlider.addEventListener("input", () => {
    state.terrain.localDecay = Number(localDecaySlider.value) / 100;
    localDecayValue.textContent = `${localDecaySlider.value}%`;
    emitTerrain();
  });

  edgeSmoothSlider.addEventListener("input", () => {
    state.terrain.edgeSmooth = Number(edgeSmoothSlider.value) / 100;
    edgeSmoothValue.textContent = `${edgeSmoothSlider.value}%`;
    emitTerrain();
  });

  function syncContinentSliderUi(): void {
    const single = state.terrain.singleContinent;
    continentSlider.disabled = single;
    continentSlider.style.opacity = single ? "0.45" : "1";
    continentValue.textContent = single ? "1（单一大陆）" : `${state.terrain.continentCount}`;
  }

  continentSlider.addEventListener("input", () => {
    state.terrain.continentCount = Number(continentSlider.value);
    continentValue.textContent = `${state.terrain.continentCount}`;
    emitTerrain();
  });

  singleContinentCb.addEventListener("change", () => {
    state.terrain.singleContinent = singleContinentCb.checked;
    syncContinentSliderUi();
    emitTerrain();
  });

  oceanRingCb.addEventListener("change", () => {
    state.terrain.oceanRing = oceanRingCb.checked;
    emitTerrain();
  });

  syncContinentSliderUi();

  tectonicSlider.addEventListener("input", () => {
    state.terrain.tectonicIterations = Number(tectonicSlider.value);
    tectonicValue.textContent = `${state.terrain.tectonicIterations}`;
    emitTerrain();
  });

  meshUniformitySlider.addEventListener("input", () => {
    state.terrain.meshUniformity = Number(meshUniformitySlider.value) / 100;
    meshUniformityValue.textContent = `${meshUniformitySlider.value}%`;
    emitTerrain();
  });

  landCentricSlider.addEventListener("input", () => {
    state.terrain.landCentric = Number(landCentricSlider.value) / 100;
    landCentricValue.textContent = `${landCentricSlider.value}%`;
    emitTerrain();
  });

  mountainSlider.addEventListener("input", () => {
    state.terrain.mountainCount = Number(mountainSlider.value);
    mountainValue.textContent = `${state.terrain.mountainCount}`;
    emitTerrain();
  });

  basinSlider.addEventListener("input", () => {
    state.terrain.basinCount = Number(basinSlider.value);
    basinValue.textContent = `${state.terrain.basinCount}`;
    emitTerrain();
  });

  oceanSlider.addEventListener("input", () => {
    state.terrain.oceanRatio = Number(oceanSlider.value) / 100;
    oceanValue.textContent = `${oceanSlider.value}%`;
    emitTerrain();
  });

  veinDensitySlider.addEventListener("input", () => {
    state.terrain.veinDensity = Number(veinDensitySlider.value) / 100;
    veinDensityValue.textContent = veinDensityLabel(state.terrain.veinDensity);
    emitTerrain();
  });

  zoomOutBtn.addEventListener("click", () => callbacks.onZoomStep(-1));
  zoomInBtn.addEventListener("click", () => callbacks.onZoomStep(1));

  container.querySelector("#pan-up")!.addEventListener("click", () => callbacks.onPanStep("up"));
  container.querySelector("#pan-down")!.addEventListener("click", () => callbacks.onPanStep("down"));
  container.querySelector("#pan-left")!.addEventListener("click", () => callbacks.onPanStep("left"));
  container.querySelector("#pan-right")!.addEventListener("click", () => callbacks.onPanStep("right"));
  container.querySelector("#pan-reset")!.addEventListener("click", () => callbacks.onPanReset());

  const layerTabs = container.querySelectorAll<HTMLButtonElement>(".layer-tab");
  layerTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const layer = btn.dataset.layer as BaseLayer;
      layerTabs.forEach((b) => b.classList.toggle("active", b === btn));
      callbacks.onBaseLayerChange(layer);
      statusEl.textContent = `显示层: ${displayModeLabel(layer)}`;
    });
  });

  function emitElementOverlays(): void {
    const keys = Array.from(
      container.querySelectorAll<HTMLInputElement>(".element-overlay-cb:checked")
    ).map((el) => el.value as ElementKey);
    callbacks.onElementOverlaysChange(keys);
  }

  container.querySelectorAll<HTMLInputElement>(".element-overlay-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      emitElementOverlays();
      const base = container.querySelector<HTMLButtonElement>(".layer-tab.active")!
        .dataset.layer as BaseLayer;
      const keys = Array.from(
        container.querySelectorAll<HTMLInputElement>(".element-overlay-cb:checked")
      ).map((el) => el.value as ElementKey);
      statusEl.textContent = `显示层: ${displayModeLabel(base, keys)}`;
    });
  });

  const metricDim = container.querySelector<HTMLSelectElement>("#metric-dim")!;
  const metricScope = container.querySelector<HTMLSelectElement>("#metric-scope")!;
  const profileAxis = container.querySelector<HTMLSelectElement>("#profile-axis")!;
  const heightScale = container.querySelector<HTMLSelectElement>("#height-scale")!;

  function emitMetricsUi(): void {
    callbacks.onMetricsUiChange?.({
      dimension: metricDim.value as MetricDimension,
      scope: metricScope.value as MetricScope,
      profileAxis: profileAxis.value as "x" | "y",
    });
  }

  metricDim.addEventListener("change", emitMetricsUi);
  metricScope.addEventListener("change", emitMetricsUi);
  profileAxis.addEventListener("change", emitMetricsUi);
  heightScale.addEventListener("change", () => {
    callbacks.onHeightColorScaleChange?.(heightScale.value as HeightColorScale);
  });

  const flatOceanCheckbox = container.querySelector<HTMLInputElement>("#flat-ocean")!;
  flatOceanCheckbox.addEventListener("change", () => {
    callbacks.onFlatOceanChange(flatOceanCheckbox.checked);
    statusEl.textContent = flatOceanCheckbox.checked
      ? "海洋已平铺为双色（浅海/深海）"
      : "海洋恢复深度配色";
  });

  const coastlineCheckbox = container.querySelector<HTMLInputElement>("#show-coastline")!;
  coastlineCheckbox.addEventListener("change", () => {
    callbacks.onCoastlineChange?.(coastlineCheckbox.checked);
    statusEl.textContent = coastlineCheckbox.checked ? "海岸线已显示" : "海岸线已隐藏";
  });

  const heightContoursCheckbox = container.querySelector<HTMLInputElement>("#show-height-contours")!;
  heightContoursCheckbox.addEventListener("change", () => {
    callbacks.onHeightContoursChange(heightContoursCheckbox.checked);
    statusEl.textContent = heightContoursCheckbox.checked
      ? "海拔等高线已开启"
      : "海拔等高线已关闭";
  });

  const cloudEnabled = container.querySelector<HTMLInputElement>("#cloud-enabled")!;
  const cloudCover = container.querySelector<HTMLInputElement>("#cloud-cover")!;
  const cloudCoverValue = container.querySelector("#cloud-cover-value")!;

  function emitCloud() {
    callbacks.onCloudChange({ ...state.cloud });
  }

  cloudEnabled.addEventListener("change", () => {
    state.cloud.enabled = cloudEnabled.checked;
    statusEl.textContent = cloudEnabled.checked ? "气旋云系已开启" : "气旋云系已关闭";
    emitCloud();
  });

  cloudCover.addEventListener("input", () => {
    state.cloud.coverage = Number(cloudCover.value) / 100;
    cloudCoverValue.textContent = `${cloudCover.value}%`;
    emitCloud();
  });

  const climateMerged = container.querySelector<HTMLInputElement>("#climate-merged")!;
  const climateLayered = container.querySelector<HTMLInputElement>("#climate-layered")!;
  const climateScalar = container.querySelector<HTMLSelectElement>("#climate-scalar")!;
  const climateScalarGroup = container.querySelector<HTMLElement>("#climate-scalar-group")!;

  function syncClimateScalarUi(): void {
    climateScalarGroup.style.display = state.climate.displayMode === "layered" ? "block" : "none";
  }

  function emitClimateUi(): void {
    callbacks.onClimateUiChange?.({ ...state.climate });
  }

  climateMerged.addEventListener("change", () => {
    if (!climateMerged.checked) return;
    state.climate.displayMode = "merged";
    syncClimateScalarUi();
    emitClimateUi();
    statusEl.textContent = "气候显示: 合并（基质+植被+云影）";
  });

  climateLayered.addEventListener("change", () => {
    if (!climateLayered.checked) return;
    state.climate.displayMode = "layered";
    syncClimateScalarUi();
    emitClimateUi();
    statusEl.textContent = "气候显示: 分层诊断";
  });

  climateScalar.addEventListener("change", () => {
    state.climate.scalarLayer = climateScalar.value as ClimateScalarLayer;
    emitClimateUi();
    const label = CLIMATE_SCALAR_LAYERS.find((l) => l.id === state.climate.scalarLayer)?.label;
    statusEl.textContent = `气候分层: ${label ?? state.climate.scalarLayer}`;
  });

  syncClimateScalarUi();

  const ecologyPlay = container.querySelector<HTMLInputElement>("#ecology-play")!;
  const simSpeedSlider = container.querySelector<HTMLInputElement>("#sim-speed-slider")!;
  const ecologySpeedValue = container.querySelector("#ecology-speed-value")!;

  function emitEcology() {
    callbacks.onEcologyChange?.({ ...state.ecology });
  }

  ecologyPlay.addEventListener("change", () => {
    state.ecology.playing = ecologyPlay.checked;
    statusEl.textContent = ecologyPlay.checked ? "模拟播放" : "模拟暂停";
    emitEcology();
  });

  simSpeedSlider.addEventListener("input", () => {
    state.ecology.playSpeed = simPlaySpeedFromIndex(Number(simSpeedSlider.value));
    ecologySpeedValue.textContent = simPlayRateLabel(state.ecology.playSpeed);
    emitEcology();
  });

  container.querySelectorAll<HTMLButtonElement>(".sim-step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const unit = btn.dataset.simStep as SimAdvanceUnit | undefined;
      if (unit) callbacks.onSimStep?.(unit);
    });
  });

  container.querySelector("#btn-seed")!.addEventListener("click", () => {
    callbacks.onRandomSeed();
    seedDisplay.textContent = String(state.terrain.seed);
    statusEl.textContent = `新种子: ${state.terrain.seed}（维诺格网 + 地形已重算）`;
  });

  container.querySelector("#btn-save-world")!.addEventListener("click", () => {
    callbacks.onSaveWorld?.();
  });
  container.querySelector("#btn-pick-region")!.addEventListener("click", () => {
    callbacks.onOpenRegionPicker?.();
  });
  container.querySelector("#btn-return-planet")!.addEventListener("click", () => {
    callbacks.onReturnPlanet?.();
  });

  return state;
}

export function setSimTimeDisplay(simDays: number): void {
  const el = document.getElementById("ecology-day-value");
  if (!el) return;
  const hour = ((simDays % 1) + 1) % 1 * 24;
  const hh = Math.floor(hour);
  const mm = Math.floor((hour - hh) * 60);
  el.textContent = `模拟 第 ${Math.floor(simDays)} 天 ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** @deprecated 使用 setSimTimeDisplay */
export function setEcologyDayDisplay(day: number): void {
  setSimTimeDisplay(day);
}

export function setControlStatus(message: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = message;
}

export function setControlSeed(state: ControlState, seed: number): void {
  state.terrain.seed = seed;
  const el = document.getElementById("seed-display");
  if (el) el.textContent = String(seed);
}

export function setRegionNavState(mode: "planet" | "region", hasSave = false): void {
  const pick = document.getElementById("btn-pick-region") as HTMLButtonElement | null;
  const ret = document.getElementById("btn-return-planet") as HTMLButtonElement | null;
  if (pick) pick.disabled = mode !== "planet" || !hasSave;
  if (ret) ret.disabled = mode !== "region";
}

export function setViewDisplay(zoomIndex: number): void {
  const zoomValue = document.getElementById("zoom-value");
  const zoomOut = document.getElementById("zoom-out") as HTMLButtonElement | null;
  const zoomIn = document.getElementById("zoom-in") as HTMLButtonElement | null;
  if (zoomValue) zoomValue.textContent = formatZoomLevel(ZOOM_LEVELS[zoomIndex]);
  if (zoomOut) zoomOut.disabled = zoomIndex <= 0;
  if (zoomIn) zoomIn.disabled = zoomIndex >= ZOOM_LEVELS.length - 1;
}

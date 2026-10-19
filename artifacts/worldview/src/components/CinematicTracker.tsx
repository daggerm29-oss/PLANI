import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { MODEL_GEOMETRY, type TrackKind, type FollowTarget } from "../lib/tracked-entity";
import type { VisionMode } from "../lib/vision-modes";

const ION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0YjdkMmFmMS04ZmU2LTQ4NDYtYTIwMS1hOTg5NGM2NzEzNGYiLCJpZCI6Mzk3MjQyLCJpYXQiOjE3NzI1Mzk5NDV9.sQ4V9RmCN2-xnXW2WZDxSAgaZTZFn9pohwFD9YzmWoU";

Cesium.Ion.defaultAccessToken = ION_TOKEN;

const EARTH_R = 6378137;
const M_PER_DEG = (Math.PI / 180) * EARTH_R;
const INTRO_RANGE = 600_000;
const EXIT_MS = 1500;
const MAX_EXTRAPOLATE_S = 60;

const KIND_CONFIG: Record<
  TrackKind,
  {
    range: number;
    pitch: number;
    scale: number;
    minPixel: number;
    maxScale: number;
    minRange: number;
    maxRange: number;
    headingTau: number;
    correctionTau: number;
    sampleSurface: boolean;
  }
> = {
  aircraft: { range: 190, pitch: -0.32, scale: 2.2, minPixel: 96, maxScale: 500, minRange: 30, maxRange: 8_000_000, headingTau: 1.2, correctionTau: 2.5, sampleSurface: false },
  ship: { range: 420, pitch: -0.32, scale: 60, minPixel: 110, maxScale: 400, minRange: 60, maxRange: 8_000_000, headingTau: 2.5, correctionTau: 3, sampleSurface: true },
  satellite: { range: 90, pitch: -0.35, scale: 6, minPixel: 110, maxScale: 60, minRange: 15, maxRange: 20_000_000, headingTau: 0.6, correctionTau: 0.8, sampleSurface: false },
};

// Cesium Ion serves Google Photorealistic 3D Tiles under its own licence, so it
// works without a billed Google Cloud project. A direct Google key is only a fallback.
async function loadGoogleTileset(): Promise<Cesium.Cesium3DTileset> {
  try {
    return await Cesium.createGooglePhotorealistic3DTileset();
  } catch (e) {
    console.error("Cesium Ion Google tiles failed, trying direct Google key", e);
  }
  const res = await fetch("/api/config/google-tiles");
  if (!res.ok) throw new Error("No Google tiles key configured");
  const { key } = (await res.json()) as { key: string };
  return Cesium.Cesium3DTileset.fromUrl(
    `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`,
    { showCreditsOnScreen: true },
  );
}

// Tints Google 3D tiles into a dark blue/cyan night-vision look.
const TILESET_NIGHT_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.UNLIT,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      vec3 c = material.diffuse;
      float gray = dot(c, vec3(0.299, 0.587, 0.114));
      gray = pow(gray, 1.6) * 0.55;
      material.diffuse = vec3(gray * 0.18, gray * 0.78, gray * 1.0);
      material.alpha = 1.0;
    }
  `,
});

interface Props {
  target: FollowTarget;
  visionMode: VisionMode;
  exiting?: boolean;
  onExited?: () => void;
}

interface VisionHandles {
  viewer: Cesium.Viewer;
  tileset: Cesium.Cesium3DTileset | null;
  osm: Cesium.ImageryLayer | null;
  esri: Cesium.ImageryLayer | null;
  nightTiles: boolean;
}

/**
 * Vision grading itself is a CSS/SVG filter on the shared world stack (so tiles and
 * models match the 2D map). Here we only pick the right source look: the night tile
 * shader for Tactical, true-colour tiles + Esri imagery globe for every other mode.
 */
function applyCesiumVision(h: VisionHandles, mode: VisionMode) {
  if (h.viewer.isDestroyed()) return;
  const tactical = mode === "tactical";
  const scene = h.viewer.scene;
  if (h.tileset) h.tileset.customShader = tactical && h.nightTiles ? TILESET_NIGHT_SHADER : undefined;
  if (h.osm) h.osm.show = tactical;
  if (h.esri) h.esri.show = !tactical;
  scene.globe.baseColor = Cesium.Color.fromCssColorString(tactical ? "#031626" : "#0b2233");
  scene.backgroundColor = Cesium.Color.fromCssColorString(tactical ? "#000000" : "#02060c");
}

interface Motion {
  lon: number;
  lat: number;
  alt: number;
  heading: number;
  speed: number;
}

/** Offsets a lon/lat by metres east/north. */
function offsetDeg(lat: number, east: number, north: number): { dLon: number; dLat: number } {
  const cosLat = Math.max(Math.cos(Cesium.Math.toRadians(lat)), 0.01);
  return { dLon: east / (M_PER_DEG * cosLat), dLat: north / M_PER_DEG };
}

function sampleKey(t: FollowTarget): string {
  return `${t.lat}|${t.lon}|${t.altM}|${t.headingDeg}|${t.speedMs}`;
}

export function CinematicTracker({ target, visionMode, exiting = false, onExited }: Props) {
  const visionRef = useRef(visionMode);
  visionRef.current = visionMode;
  const handlesRef = useRef<VisionHandles | null>(null);
  useEffect(() => {
    if (handlesRef.current) applyCesiumVision(handlesRef.current, visionMode);
  }, [visionMode]);
  const kind = target.kind;
  const cfg = KIND_CONFIG[kind];
  const geometry = MODEL_GEOMETRY[target.modelUrl.split("/").pop() ?? ""] ?? { headingOffsetDeg: 0, keelDepth: 0 };
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<FollowTarget>(target);
  const sampleKeyRef = useRef<string>("");
  const sampleTimeRef = useRef<number>(performance.now());
  const motionRef = useRef<Motion | null>(null);
  const camRef = useRef({
    yaw: 0,
    pitch: cfg.pitch,
    logRange: Math.log(INTRO_RANGE),
    logTarget: Math.log(cfg.range),
  });
  const [visible, setVisible] = useState(false);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // The parent re-creates `target` on every render; only a changed position/velocity
  // is a new sample. Treating every render as a sample made the model snap backwards.
  useEffect(() => {
    targetRef.current = target;
    if (target.lat === undefined || target.lon === undefined) return;
    const key = sampleKey(target);
    if (key === sampleKeyRef.current) return;
    sampleKeyRef.current = key;
    sampleTimeRef.current = performance.now() - Math.min(target.sampleAgeSec ?? 0, 15) * 1000;
    if (motionRef.current === null) {
      motionRef.current = {
        lon: target.lon,
        lat: target.lat,
        alt: target.altM ?? 0,
        heading: target.headingDeg ?? 0,
        speed: target.speedMs ?? 0,
      };
    }
  }, [target]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Graceful exit: pull the camera back up, fade, then notify the parent.
  useEffect(() => {
    if (!exiting) return;
    camRef.current.logTarget = Math.log(INTRO_RANGE);
    const fade = setTimeout(() => setVisible(false), EXIT_MS * 0.45);
    const done = setTimeout(() => onExitedRef.current?.(), EXIT_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [exiting]);

  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let viewer: Cesium.Viewer | null = null;
    const cleanups: Array<() => void> = [];

    try {
      viewer = new Cesium.Viewer(container, {
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        navigationInstructionsInitiallyVisible: false,
        baseLayer: false,
      });

      const v = viewer;
      const scene = v.scene;
      scene.backgroundColor = Cesium.Color.BLACK;
      // The globe is visible until the photorealistic tiles arrive so the view is never empty.
      scene.globe.show = true;
      scene.globe.baseColor = Cesium.Color.fromCssColorString("#031626");
      scene.fog.enabled = false;
      if (scene.sun) scene.sun.show = true;
      if (scene.moon) scene.moon.show = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = kind === "satellite";
      scene.screenSpaceCameraController.enableInputs = false;

      const fixedTime = Cesium.JulianDate.fromIso8601("2024-06-15T22:30:00Z");
      v.clock.startTime = fixedTime.clone();
      v.clock.currentTime = fixedTime.clone();
      v.clock.stopTime = fixedTime.clone();
      v.clock.clockRange = Cesium.ClockRange.CLAMPED;
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      const handles: VisionHandles = { viewer: v, tileset: null, osm: null, esri: null, nightTiles: kind === "aircraft" };
      handlesRef.current = handles;
      try {
        const layer = v.imageryLayers.addImageryProvider(
          new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
        );
        layer.brightness = 0.45;
        layer.saturation = 0.5;
        handles.osm = layer;
      } catch (e) {
        console.error("Failed to add imagery", e);
      }
      try {
        handles.esri = v.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            maximumLevel: 19,
            credit: "Imagery © Esri, Maxar, Earthstar Geographics",
          }),
        );
      } catch (e) {
        console.error("Failed to add satellite imagery", e);
      }
      applyCesiumVision(handles, visionRef.current);

      const updateLight = () => {
        if (v.isDestroyed()) return;
        scene.light = new Cesium.DirectionalLight({
          direction: Cesium.Cartesian3.clone(scene.camera.directionWC),
          color: Cesium.Color.WHITE,
          intensity: 2.5,
        });
      };
      updateLight();

      const scratchPos = new Cesium.Cartesian3();
      const computePosition = (): Cesium.Cartesian3 => {
        const m = motionRef.current;
        if (!m) return Cesium.Cartesian3.fromDegrees(0, 0, 0, undefined, scratchPos);
        return Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.alt, undefined, scratchPos);
      };

      // A model primitive (not an entity) so its matrix is set in the same preRender pass
      // as the camera; entities are evaluated a frame earlier, which made the model trail
      // and stutter relative to the camera. Added immediately, before any tiles load.
      let model: Cesium.Model | null = null;
      Cesium.Model.fromGltfAsync({
        url: targetRef.current.modelUrl,
        minimumPixelSize: cfg.minPixel,
        maximumScale: cfg.maxScale,
        scale: cfg.scale,
        shadows: Cesium.ShadowMode.DISABLED,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        show: false,
      })
        .then((mdl) => {
          if (cancelled || v.isDestroyed()) {
            mdl.destroy();
            return;
          }
          model = scene.primitives.add(mdl) as Cesium.Model;
        })
        .catch((e) => console.error("Failed to load model", e));
      const scratchHpr = new Cesium.HeadingPitchRoll();
      const scratchMatrix = new Cesium.Matrix4();

      // Surface height under the object (sea level from the tiles is at the geoid, not h=0).
      let tileset: Cesium.Cesium3DTileset | null = null;
      const surface = { height: 0, pending: false, lastMs: 0 };
      const needsSurface = () => cfg.sampleSurface || (kind === "aircraft" && (targetRef.current.altM ?? 0) < 1500);
      const sampleSurface = () => {
        const m = motionRef.current;
        if (!m || !tileset || surface.pending) return;
        surface.pending = true;
        scene
          .sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(m.lon, m.lat)], model ? [model] : [])
          .then(([c]) => {
            if (c && Number.isFinite(c.height)) surface.height = c.height;
          })
          .catch(() => {})
          .finally(() => {
            surface.pending = false;
            surface.lastMs = performance.now();
          });
      };

      if (kind === "aircraft" || kind === "ship") {
        loadGoogleTileset()
          .then((ts) => {
            if (cancelled || v.isDestroyed()) return;
            scene.primitives.add(ts);
            tileset = ts;
            handles.tileset = ts;
            applyCesiumVision(handles, visionRef.current);
            // Google tiles include the sea surface; hide the globe to avoid z-fighting.
            scene.globe.show = false;
            if (needsSurface()) sampleSurface();
          })
          .catch((e) => console.error("Failed to load Google 3D tileset", e));
      }

      const targetAltitude = (): number => {
        const t = targetRef.current;
        if (kind === "ship") return surface.height + geometry.keelDepth * cfg.scale;
        if (kind === "aircraft") return Math.max(t.altM ?? 0, surface.height + 2);
        return t.altM ?? 0;
      };

      // ---- Per-frame update: velocity integration + smooth error correction ----
      let lastFrameMs = performance.now();

      scene.preRender.addEventListener(() => {
        if (v.isDestroyed()) return;
        updateLight();
        const now = performance.now();
        const dt = Math.min((now - lastFrameMs) / 1000, 0.1);
        lastFrameMs = now;
        const t = targetRef.current;
        const m = motionRef.current;
        if (!m || t.lat === undefined || t.lon === undefined) return;

        if (tileset && needsSurface() && now - surface.lastMs > 5000) sampleSurface();

        const tSpeed = t.speedMs ?? 0;
        const tHeading = t.headingDeg ?? m.heading;

        // Where the latest sample says the object is right now.
        const age = Math.min((now - sampleTimeRef.current) / 1000, MAX_EXTRAPOLATE_S);
        const sampleHdg = Cesium.Math.toRadians(tHeading);
        const ahead = tSpeed * age;
        const pred = offsetDeg(t.lat, ahead * Math.sin(sampleHdg), ahead * Math.cos(sampleHdg));
        const pLat = t.lat + pred.dLat;
        const pLon = t.lon + pred.dLon;

        m.speed += (tSpeed - m.speed) * (1 - Math.exp(-dt / 2));
        const dh = (((tHeading - m.heading + 540) % 360) - 180);
        m.heading = (m.heading + dh * (1 - Math.exp(-dt / cfg.headingTau)) + 360) % 360;

        const hdg = Cesium.Math.toRadians(m.heading);
        const sinH = Math.sin(hdg);
        const cosH = Math.cos(hdg);
        const cosLat = Math.max(Math.cos(Cesium.Math.toRadians(m.lat)), 0.01);
        const errEast = (pLon - m.lon) * M_PER_DEG * cosLat;
        const errNorth = (pLat - m.lat) * M_PER_DEG;
        const errDist = Math.hypot(errEast, errNorth);

        if (errDist > Math.max(3000, tSpeed * 30)) {
          // Far off (first fix, teleport, feed gap): jump instead of sliding across the map.
          m.lon = pLon;
          m.lat = pLat;
        } else {
          // Move with own velocity, then bleed off the error. The along-track part is
          // clamped so the model never visibly reverses when a sample lags behind.
          const step = m.speed * dt;
          const c = 1 - Math.exp(-dt / cfg.correctionTau);
          const along = errEast * sinH + errNorth * cosH;
          const cross = errEast * cosH - errNorth * sinH;
          const alongCorr = Math.max(along * c, -0.7 * step);
          const crossCorr = cross * c;
          const forward = step + alongCorr;
          const east = forward * sinH + crossCorr * cosH;
          const north = forward * cosH - crossCorr * sinH;
          const o = offsetDeg(m.lat, east, north);
          m.lon += o.dLon;
          m.lat += o.dLat;
        }
        m.alt += (targetAltitude() - m.alt) * (1 - Math.exp(-dt / 1.5));

        const pos = computePosition();
        if (model) {
          scratchHpr.heading = Cesium.Math.toRadians(m.heading + geometry.headingOffsetDeg);
          model.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(pos, scratchHpr, undefined, undefined, scratchMatrix);
          model.show = true;
        }
        const cam = camRef.current;
        const rk = 1 - Math.exp(-dt / (exitingRef.current ? 0.45 : 0.5));
        cam.logRange += (cam.logTarget - cam.logRange) * rk;
        scene.camera.lookAt(
          pos,
          new Cesium.HeadingPitchRange(hdg + cam.yaw, cam.pitch, Math.exp(cam.logRange)),
        );
      });

      // ---- Orbit / zoom input ----
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const onDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        container.setPointerCapture?.(e.pointerId);
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging || exitingRef.current) return;
        const cam = camRef.current;
        cam.yaw -= (e.clientX - lastX) * 0.005;
        cam.pitch = Math.max(-1.5, Math.min(0.25, cam.pitch - (e.clientY - lastY) * 0.004));
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onUp = () => {
        dragging = false;
      };
      const onWheel = (e: WheelEvent) => {
        if (exitingRef.current) return;
        e.preventDefault();
        const cam = camRef.current;
        cam.logTarget = Math.max(
          Math.log(cfg.minRange),
          Math.min(Math.log(cfg.maxRange), cam.logTarget + e.deltaY * 0.001),
        );
      };
      container.addEventListener("pointerdown", onDown);
      container.addEventListener("pointermove", onMove);
      container.addEventListener("pointerup", onUp);
      container.addEventListener("pointercancel", onUp);
      container.addEventListener("wheel", onWheel, { passive: false });
      cleanups.push(() => {
        container.removeEventListener("pointerdown", onDown);
        container.removeEventListener("pointermove", onMove);
        container.removeEventListener("pointerup", onUp);
        container.removeEventListener("pointercancel", onUp);
        container.removeEventListener("wheel", onWheel);
      });
    } catch (e) {
      console.error("Cesium viewer init failed", e);
    }

    return () => {
      cancelled = true;
      handlesRef.current = null;
      cleanups.forEach((fn) => fn());
      try {
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.modelUrl, kind]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        background: "#000005",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.7s ease",
        touchAction: "none",
        cursor: "grab",
      }}
    />
  );
}

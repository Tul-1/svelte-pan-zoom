import { disablePreload } from "svelte-disable-preload";
import { resize } from "svelte-resize-observer-action";

export interface Point {
    x: number;
    y: number;
}

interface TrackedPoint {
    point: Point;
    t: number;
}

interface Velocity {
    vx: number;
    vy: number;
    ts: number;
}

interface Bounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

const distance = (p1: Point, p2: Point) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
const midpoint = (p1: Point, p2: Point) =>
    <Point>{ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
const subtract = (p1: Point, p2: Point) =>
    <Point>{ x: p1.x - p2.x, y: p1.y - p2.y };

const MIN_VELOCITY = 0.02;
const TRACKED_DURATION = 120;

type Render = (
    ctx: CanvasRenderingContext2D,
    t: number,
    focus: Point,
) => void | boolean;

export interface Options {
    width: number;
    height: number;
    render: Render;
    padding?: number;
    maxZoom?: number;
    minZoomMultiplier?: number;
    friction?: number;
    visibilityBounds?: Partial<Bounds>;
}

export function panzoom(canvas: HTMLCanvasElement, options: Options) {
    const dpr = window.devicePixelRatio;
    const ctx = canvas.getContext("2d")!;
    const rAF = requestAnimationFrame;

    let baseZoom: number;
    let minZoom: number;
    let width: number;
    let height: number;
    let render: Render;
    let padding: number;
    let maxZoom: number;
    let minZoomMultiplier: number;
    let friction: number;
    let view_width = (canvas.width = canvas.clientWidth * dpr);
    let view_height = (canvas.height = canvas.clientHeight * dpr);
    let focus: Point;
    let frame = 0;
    let velocity: Velocity = { vx: 0, vy: 0, ts: 0 };

    let visibilityBounds: Required<Bounds>;

    // Concrete image-space boundaries (absolute edge positions)
    let absoluteBounds: Required<Bounds>;

    const pointers = new Map<number, Point>();
    const tracked: TrackedPoint[] = [];

    function initialize(options: Options) {
        ({
            width,
            height,
            render,
            padding,
            maxZoom,
            minZoomMultiplier,
            friction,
        } = {
            padding: 0,
            maxZoom: 16,
            minZoomMultiplier: 0.5,
            friction: 0.97,
            ...options,
        });

        baseZoom = Math.min(
            canvas.width / (width + padding),
            canvas.height / (height + padding),
        );

        visibilityBounds = {
            left: options.visibilityBounds?.left ?? 0.5,
            right: options.visibilityBounds?.right ?? 0.5,
            top: options.visibilityBounds?.top ?? 0.5,
            bottom: options.visibilityBounds?.bottom ?? 0.5,
        };

        calculateAbsoluteBounds();

        ctx.resetTransform();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.scale(baseZoom, baseZoom);
        ctx.translate(-width / 2, -height / 2);

        stopMovement();
        focus = toImageSpace({ x: canvas.width / 2, y: canvas.height / 2 });

        // Ensure constraints are satisfied immediately on boot
        checkBounds();
        scheduleRender();
    }

    // Maps the visibility fractions to absolute coordinate limits in image-space
    function calculateAbsoluteBounds() {
        const allowedInvisibleW = canvas.width / 2 / baseZoom;
        const allowedInvisibleH = canvas.height / 2 / baseZoom;

        absoluteBounds = {
            left: 0 - allowedInvisibleW * (1 - visibilityBounds.left),
            right: width + allowedInvisibleW * (1 - visibilityBounds.right),
            top: 0 - allowedInvisibleH * (1 - visibilityBounds.top),
            bottom: height + allowedInvisibleH * (1 - visibilityBounds.bottom),
        };

        // Enforce a dynamic minimum zoom floor to prevent visibility thresholds from revealing structural void space
        const boundWidth = absoluteBounds.right - absoluteBounds.left;
        const boundHeight = absoluteBounds.bottom - absoluteBounds.top;

        const strictMinZoom = Math.max(
            canvas.width / boundWidth,
            canvas.height / boundHeight,
        );

        minZoom = Math.max(baseZoom * minZoomMultiplier, strictMinZoom);
    }

    initialize(options);

    const preloadAction = disablePreload(canvas);
    const resizeAction = resize(canvas, (entry) => {
        if (canvas.clientWidth === 0 && canvas.clientHeight === 0) {
            return;
        }

        const rect = entry.contentRect;
        const prev = toImageSpace({ x: view_width / 2, y: view_height / 2 });
        const transform = ctx.getTransform();

        view_width = rect.width * dpr;
        view_height = rect.height * dpr;

        canvas.width = view_width;
        canvas.height = view_height;

        baseZoom = Math.min(
            canvas.width / (options.width + padding),
            canvas.height / (options.height + padding),
        );

        calculateAbsoluteBounds();

        ctx.setTransform(transform);
        focus = toImageSpace({ x: view_width / 2, y: view_height / 2 });
        ctx.translate(focus.x - prev.x, focus.y - prev.y);

        checkBounds();

        if (!frame) {
            renderFrame(performance.now());
        }
    });

    function prune(t: number) {
        while (tracked.length && t - tracked[0].t > TRACKED_DURATION) {
            tracked.shift();
        }
    }

    function track(point: Point) {
        const t = performance.now();
        prune(t);
        tracked.push({ point, t });
    }

    function stopMovement() {
        if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
        }
        velocity.vx = 0;
        velocity.vy = 0;
        tracked.length = 0;
    }

    // Advanced Map-Style Bounds Clamping Engine (Viewport Edge Constraining & Inertia Absorption)
    function checkBounds() {
        const tl = toImageSpace({ x: 0, y: 0 });
        const br = toImageSpace({ x: canvas.width, y: canvas.height });

        // Horizontal Evaluation
        if (tl.x < absoluteBounds.left) {
            ctx.translate(tl.x - absoluteBounds.left, 0);
            velocity.vx = 0; // Absorbs kinetic inertia on wall collision
        } else if (br.x > absoluteBounds.right) {
            ctx.translate(br.x - absoluteBounds.right, 0);
            velocity.vx = 0;
        }

        // Vertical Evaluation
        if (tl.y < absoluteBounds.top) {
            ctx.translate(0, tl.y - absoluteBounds.top);
            velocity.vy = 0;
        } else if (br.y > absoluteBounds.bottom) {
            ctx.translate(0, br.y - absoluteBounds.bottom);
            velocity.vy = 0;
        }
    }

    function onpointerdown(event: PointerEvent) {
        event.stopPropagation();
        canvas.setPointerCapture(event.pointerId);

        const point = pointFromEvent(event);
        pointers.set(event.pointerId, point);

        stopMovement();
    }

    function onpointerend(event: PointerEvent) {
        event.stopPropagation();
        canvas.releasePointerCapture(event.pointerId);

        pointers.delete(event.pointerId);

        if (pointers.size === 0) {
            prune(performance.now());

            if (tracked.length > 1) {
                const oldest = tracked[0];
                const latest = tracked[tracked.length - 1];

                const x = latest.point.x - oldest.point.x;
                const y = latest.point.y - oldest.point.y;
                const t = latest.t - oldest.t;

                if (t > 0) {
                    velocity = {
                        vx: x / t,
                        vy: y / t,
                        ts: performance.now(),
                    };
                }

                scheduleRender();
            }
        }
    }

    function onpointermove(event: PointerEvent) {
        event.stopPropagation();
        if (!pointers.has(event.pointerId)) return;

        const point = pointFromEvent(event);

        switch (pointers.size) {
            case 1: {
                const curr = toImageSpace(point);
                track(curr);

                const prev = pointers.get(event.pointerId)!;
                const diff = subtract(curr, toImageSpace(prev));

                focus = curr;

                moveBy(diff);
                scheduleRender();

                pointers.set(event.pointerId, point);
                break;
            }
            case 2: {
                let points = [...pointers.values()];
                let p1 = toImageSpace(points[0]);
                let p2 = toImageSpace(points[1]);
                const prev_middle = midpoint(p1, p2);
                const prev_dist = distance(p1, p2);

                pointers.set(event.pointerId, point);

                points = [...pointers.values()];
                p1 = toImageSpace(points[0]);
                p2 = toImageSpace(points[1]);
                const middle = midpoint(p1, p2);
                const dist = distance(p1, p2);

                const diff = subtract(middle, prev_middle);
                moveBy(diff);

                const zoom = dist / prev_dist;
                zoomOn(middle, zoom);
                break;
            }
        }
    }

    function onwheel(event: WheelEvent) {
        event.preventDefault();
        event.stopPropagation();

        const point = pointFromEvent(event);
        const z = Math.exp(-event.deltaY / 512);

        zoomOn(toImageSpace(point), z);
    }

    function moveBy(delta: Point) {
        ctx.translate(delta.x, delta.y);
        checkBounds();
    }

    // Camera Zoom Anchoring Module
    function zoomOn(point: Point, zoom: number) {
        function scale(value: number) {
            ctx.translate(point.x, point.y);
            ctx.scale(value, value);
            ctx.translate(-point.x, -point.y);
        }

        scale(zoom);

        let transform = ctx.getTransform();

        if (transform.a < minZoom) {
            scale(minZoom / transform.a);
        }

        if (transform.a > maxZoom) {
            scale(maxZoom / transform.a);
        }

        focus = point;

        // Map style interaction: Run checkbounds mid-zoom execution to
        // cleanly push camera coordinates inward if zooming along margins.
        checkBounds();
        scheduleRender();
    }

    function pointFromEvent(event: PointerEvent | WheelEvent): Point {
        return { x: event.offsetX * dpr, y: event.offsetY * dpr };
    }

    function toImageSpace(point: Point): Point {
        const inverse = ctx.getTransform().inverse();
        return inverse.transformPoint(point);
    }

    function scheduleRender() {
        if (!frame) {
            frame = rAF(renderFrame);
        }
    }

    function renderFrame(t: number) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        const playing = render(ctx, t, focus);

        const transform = ctx.getTransform();
        const dist =
            Math.sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy) *
            transform.a;
        const moving = dist > MIN_VELOCITY;

        if (moving) {
            const ts = t - velocity.ts;
            const x = velocity.vx * ts;
            const y = velocity.vy * ts;

            moveBy({ x, y });

            velocity.vx *= friction;
            velocity.vy *= friction;
            velocity.ts = t;
        }

        if (moving || playing) {
            frame = rAF(renderFrame);
        } else {
            frame = 0;
        }
    }

    const makePassive = { passive: true };

    canvas.addEventListener("pointerdown", onpointerdown, makePassive);
    canvas.addEventListener("pointerup", onpointerend, makePassive);
    canvas.addEventListener("pointercancel", onpointerend, makePassive);
    canvas.addEventListener("pointermove", onpointermove, makePassive);
    canvas.addEventListener("wheel", onwheel);

    return {
        update(options: Options) {
            initialize(options);
        },
        destroy() {
            preloadAction.destroy();
            resizeAction.destroy();

            canvas.removeEventListener("pointerdown", onpointerdown);
            canvas.removeEventListener("pointerup", onpointerend);
            canvas.removeEventListener("pointercancel", onpointerend);
            canvas.removeEventListener("pointermove", onpointermove);
            canvas.removeEventListener("wheel", onwheel);
        },
    };
}

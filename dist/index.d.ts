interface Point {
    x: number;
    y: number;
}
interface Bounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}
type Render = (ctx: CanvasRenderingContext2D, t: number, focus: Point) => void | boolean;
interface Options {
    width: number;
    height: number;
    render: Render;
    padding?: number;
    maxZoom?: number;
    minZoomMultiplier?: number;
    friction?: number;
    visibilityBounds?: Partial<Bounds>;
}
declare function panzoom(canvas: HTMLCanvasElement, options: Options): {
    update(options: Options): void;
    destroy(): void;
};

export { type Options, type Point, panzoom };

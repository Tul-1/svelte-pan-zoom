interface Point {
    x: number;
    y: number;
}
type Render = (ctx: CanvasRenderingContext2D, t: number, focus: Point) => void | boolean;
interface Bounds {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
}
interface Options {
    width: number;
    height: number;
    render: Render;
    padding?: number;
    maxZoom?: number;
    friction?: number;
    centerBounds?: Partial<Bounds>;
}
declare function panzoom(canvas: HTMLCanvasElement, options: Options): {
    update(options: Options): void;
    destroy(): void;
};

export { type Bounds, type Options, type Point, panzoom };

"use client";

/**
 * Error boundary for the 3D viewport.
 *
 * A WebGPU/R3F failure (renderer init, a material that fails to compile, a lost
 * device surfaced as a render error) would otherwise blank the whole editor.
 * This catches it and shows a recoverable fallback instead. Remounting with a
 * fresh `key` clears the caught error and rebuilds the canvas from scratch.
 */
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Static node, or a render function that receives the caught error so the
   * fallback can show what actually failed (e.g. GPUDeviceLost). */
  fallback: ReactNode | ((error: Error) => ReactNode);
}

interface State {
  error: Error | null;
}

export default class ViewportBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      return typeof fallback === "function" ? fallback(error) : fallback;
    }
    return this.props.children;
  }
}

/**
 * ErrorBoundary
 *
 * React error boundary with Xochi-themed fallback.
 * Catches unhandled exceptions in the component tree.
 */

import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="error-boundary">
          <pre className="error-boundary__art">
            {`     .  *  .
   .  /|\\  .
  . / | \\ .
   /__|__\\
  |   !   |
  |_______|

  SYSTEM FAULT`}
          </pre>
          <h2 className="error-boundary__title">Something broke</h2>
          <p className="error-boundary__message">
            {this.state.error?.message || "An unexpected error occurred"}
          </p>
          <div className="error-boundary__actions">
            <button className="error-boundary__btn" onClick={this.handleReset}>
              Try again
            </button>
            <button
              className="error-boundary__btn error-boundary__btn--secondary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

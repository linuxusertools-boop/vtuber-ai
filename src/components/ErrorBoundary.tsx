import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  failed: boolean;
  attempt: number;
}

/** Jaring pengaman terakhir: error render apa pun tidak boleh menghasilkan layar kosong. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, attempt: 0 };
  private timer: number | undefined;

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Huohuo] render error:", error, info.componentStack);
    // pulihkan otomatis maksimal 2 kali, setelah itu minta pengguna memuat ulang
    if (this.state.attempt < 2) {
      this.timer = window.setTimeout(
        () => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 })),
        900,
      );
    }
  }

  componentWillUnmount() {
    clearTimeout(this.timer);
  }

  render() {
    if (!this.state.failed) return <div key={this.state.attempt} style={{ height: "100%" }}>{this.props.children}</div>;
    return (
      <div className="crash">
        <div className="crash-title">HUOHUO</div>
        <div className="crash-sub">
          {this.state.attempt < 2 ? "menyambung ulang…" : "ada yang tersendat"}
        </div>
        {this.state.attempt >= 2 && (
          <button className="unlock-btn" onClick={() => window.location.reload()}>
            Muat ulang
          </button>
        )}
      </div>
    );
  }
}

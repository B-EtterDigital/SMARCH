import { render } from "preact";
import { StatsTiles } from "../components/stats-tiles";
import { ThemeToggle } from "../components/theme-toggle";
import { ToastCenter } from "../components/toast-center";
import { VerdictStamp } from "../components/verdict-stamp";
import "../tokens.css";
import "../app.css";

function Fixtures() {
  return (
    <main>
      <header class="page-heading"><p>COMPONENT FIXTURE / VISUAL REGRESSION</p><h1>Dashboard primitives</h1></header>
      <section class="fixture-section">
        <h2>Stats tiles / populated</h2>
        <StatsTiles values={{ bricks: 1284, canonical: 87, leases: 12, conflicts: 3 }} />
        <h2>Stats tiles / loading, empty, error</h2>
        <StatsTiles state="loading" />
        <StatsTiles state="empty" />
        <StatsTiles state="error" error={new Error("fixture failure")} />
      </section>
      <section class="fixture-section"><h2>Theme toggle</h2><ThemeToggle /></section>
      <section class="fixture-section"><h2>Verdict stamps</h2><div class="fixture-row"><VerdictStamp verdict="pass" /><VerdictStamp verdict="fail" /><VerdictStamp verdict="waived" /></div></section>
      <ToastCenter dismissAfterMs={60_000} toasts={[
        { id: "pass", message: "Registry refresh completed.", verdict: "pass" },
        { id: "fail", message: "Lease collision requires review.", verdict: "fail" },
        { id: "waived", message: "Visual proof waived for local fixture.", verdict: "waived" }
      ]} />
    </main>
  );
}

const root = document.getElementById("fixture-root");
if (root) render(<Fixtures />, root);

import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Moon, Sun, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/icons";
import { useColorMode } from "@/hooks/use-color-mode";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/ticker", label: "Asset detail" },
  { to: "/compare", label: "Compare" },
  { to: "/simulator", label: "Strategy simulator" },
];

export function AppLayout() {
  const { mode, setMode } = useColorMode();
  const location = useLocation();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center gap-6">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Logo className="h-5 w-5 text-primary" />
            <span>Market Trends</span>
          </Link>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {NAV.map((item) => {
              const active =
                item.to === "/"
                  ? location.pathname === "/"
                  : location.pathname.startsWith(item.to);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                  )}
                >
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
          <ColorModeToggle mode={mode} onChange={setMode} />
        </div>
      </header>
      <main className="container flex-1 py-6">
        <Outlet />
      </main>
      <footer className="border-t py-4 text-xs text-muted-foreground">
        <div className="container flex flex-wrap items-center justify-between gap-2">
          <span>
            Not financial advice. Outputs are systematic valuation signals, not
            recommendations.
          </span>
          <span>
            Log-price regression · z-score · staircase allocation
          </span>
        </div>
      </footer>
    </div>
  );
}

function ColorModeToggle({
  mode,
  onChange,
}: {
  mode: "light" | "dark" | "system";
  onChange: (m: "light" | "dark" | "system") => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border p-0.5">
      <Button
        size="icon"
        variant={mode === "light" ? "secondary" : "ghost"}
        className="h-7 w-7"
        onClick={() => onChange("light")}
        aria-label="Light mode"
      >
        <Sun className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant={mode === "dark" ? "secondary" : "ghost"}
        className="h-7 w-7"
        onClick={() => onChange("dark")}
        aria-label="Dark mode"
      >
        <Moon className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant={mode === "system" ? "secondary" : "ghost"}
        className="h-7 w-7"
        onClick={() => onChange("system")}
        aria-label="System theme"
      >
        <MonitorSmartphone className="h-4 w-4" />
      </Button>
    </div>
  );
}

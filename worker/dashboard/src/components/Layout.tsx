import { useState } from "react";
import { NavLink, Outlet } from "react-router";

const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: "◉" },
  { to: "/clients", label: "Clients", icon: "⊞" },
  { to: "/alerts", label: "Alerts", icon: "⚠" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export function Layout({ onLogout }: { onLogout: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen">
      {/* Mobile header */}
      <div className="fixed top-0 left-0 right-0 z-30 flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 md:hidden">
        <span className="text-lg font-bold tracking-tight text-[var(--color-accent)]">PingPulse</span>
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          {mobileOpen ? "\u2715" : "\u2630"}
        </button>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav
        className={`fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform duration-200 md:static md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-zinc-800 px-4">
          <span className="text-lg font-bold tracking-tight text-[var(--color-accent)]">PingPulse</span>
        </div>

        <div className="flex flex-1 flex-col gap-1 p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`
              }
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>

        <div className="border-t border-zinc-800 p-3">
          <button
            onClick={onLogout}
            className="w-full rounded-md px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-zinc-950 p-4 pt-18 md:p-6 md:pt-6">
        <Outlet />
      </main>
    </div>
  );
}

import { Navigate } from "react-router";

export function ProtectedRoute({
  authed,
  children,
}: {
  authed: boolean | null;
  children: React.ReactNode;
}) {
  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-sm text-zinc-400">Loading...</div>
      </div>
    );
  }

  if (!authed) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

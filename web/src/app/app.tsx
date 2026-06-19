import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./layout.js";
import { DashboardPage } from "./routes/dashboard.js";
import { AssetDetailPage } from "./routes/asset-detail.js";
import { ComparePage } from "./routes/compare.js";
import { TooltipProvider } from "@/components/ui/tooltip";

export function App() {
  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={120}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="ticker" element={<AssetDetailPage />} />
            <Route path="compare" element={<ComparePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </TooltipProvider>
    </BrowserRouter>
  );
}

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTheme } from "./hooks/useTheme.js";
import { Configurator } from "./pages/Configurator.js";

/**
 * The configurator at `/`. Its only provider is a query client, for the one
 * read it makes itself: the solver capability matrix its options are built
 * from. The live preview is an iframe of /embed, which brings its own.
 */
export default function ConfiguratorApp() {
  useTheme();
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <div className="pearl-bg demo-bg" />
      <div className="dark-overlay demo-overlay" />
      <Configurator />
    </QueryClientProvider>
  );
}

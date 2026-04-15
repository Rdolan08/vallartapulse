import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { LanguageProvider } from "@/contexts/language-context";

import Dashboard from "@/pages/dashboard";
import Tourism from "@/pages/tourism";
import RentalMarket from "@/pages/rental-market";
import Economic from "@/pages/economic";
import Safety from "@/pages/safety";
import Weather from "@/pages/weather";
import Sources from "@/pages/sources";
import PricingTool from "@/pages/pricing-tool";
import About from "@/pages/about";
import Contact from "@/pages/contact";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/tourism" component={Tourism} />
      <Route path="/rental-market" component={RentalMarket} />
      <Route path="/pricing-tool" component={PricingTool} />
      <Route path="/economic" component={Economic} />
      <Route path="/safety" component={Safety} />
      <Route path="/weather" component={Weather} />
      <Route path="/sources" component={Sources} />
      <Route path="/about" component={About} />
      <Route path="/contact" component={Contact} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;

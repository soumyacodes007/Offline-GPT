import { Suspense } from "react";
import { MyAccessScreen } from "../_components/my-access-screen";

export default function MyAccessPage() {
  return (
    <Suspense fallback={null}>
      <MyAccessScreen />
    </Suspense>
  );
}

"use client";

import Recorder from "./components/Recorder";
import NoSSRWrapper from "./NoSSRWrapper";

export default function HomePage() {
  return (
    <NoSSRWrapper>
      <Recorder />
    </NoSSRWrapper>
  );
}

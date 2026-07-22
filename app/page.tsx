import { redirect } from "next/navigation";

export default function Home() {
  // Middleware handles the unauthenticated case; signed-in users land here.
  redirect("/clients");
}

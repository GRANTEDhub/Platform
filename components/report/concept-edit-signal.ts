// A one-line channel from the concept card in the rail to the concept panel further down
// the page: "open your editor".
//
// WHY A SIGNAL AND NOT A PROP. The two live in different slots of GrantReviewConsole and
// are passed in from a SERVER component, so there is no shared React state to lift the
// `editing` flag into without wrapping the whole console in a client provider. That is a
// lot of restructuring to move one boolean.
//
// WHY NOT A URL HASH, which was the obvious cheap alternative. `#concept-edit` only fires
// hashchange when the hash CHANGES -- so closing the editor and clicking Edit again does
// nothing, because the hash is already what it was. An event fires every time it is sent,
// which is the behaviour a button needs.
//
// Scoped by cardId so a page that ever renders two of these cannot cross-trigger.

const EVENT = "granted:concept-edit";

export function requestConceptEdit(cardId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { cardId } }));
}

// Returns the unsubscribe function, so a caller can use it as an effect body directly.
export function onConceptEditRequest(cardId: string, fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    if ((e as CustomEvent<{ cardId?: string }>).detail?.cardId === cardId) fn();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

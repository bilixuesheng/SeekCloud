import type { GreetingSet } from "../session/greetings";

/**
 * English greetings for the new-session page (one is picked at random each time; the rules live in
 * session/greetings.ts). Written for English on their own, not translated from the Chinese set (#136).
 * Literary is fine, playful is not (docs/brand/README.md). Quotations are public-domain originals, with the
 * source after each. No "good morning"-style pleasantries, same as the Chinese set.
 *
 * At most 28 characters without the name: about one line at the phone size of the greeting.
 */
export const enGreetings: GreetingSet = {
  maxLength: 28,
  // Tennyson, "Ulysses"
  seek: "To strive, to seek, to find",
  always: [
    "What are we building today?",
    "Where shall we begin?",
    "Describe your task",
    "Welcome back",
    "Ready when you are",
    "What's on your mind?",
    // Seeking, beginning
    "Hitch your wagon to a star", // Emerson, "Civilization"
    "Two roads diverged in a wood", // Frost, "The Road Not Taken"
    "What's past is prologue", // Shakespeare, The Tempest
    "The readiness is all", // Shakespeare, Hamlet
    "Knowledge is power", // Francis Bacon
    "Per aspera ad astra", // Latin motto
    "Fortune favors the bold", // Terence
    "Onward and upward",
    // Craft, patience
    "Well begun is half done", // Aristotle, Politics
    "Measure twice, cut once", // proverb
    "Make haste slowly", // Augustus, via Suetonius
    "Rome was not built in a day", // proverb
    "Brevity is the soul of wit", // Shakespeare, Hamlet
    "One step at a time",
    // Sky, hope
    "I wandered lonely as a cloud", // Wordsworth
    "Hope springs eternal", // Pope, An Essay on Man
    "The best is yet to be", // Browning, "Rabbi Ben Ezra"
  ],
  alwaysNamed: [
    "Welcome back, {name}",
    "Hello, {name}",
    "Good to see you, {name}",
    "{name}, what's next?",
    "Shall we continue, {name}?",
    "{name}, what's the plan?",
  ],
  byHour: [
    [5, 11, ["A new day begins", "The day is young", "Fresh morning, fresh ideas"], []],
    [
      18,
      23,
      // Tennyson, "Crossing the Bar"
      ["Twilight and evening bell", "The evening is yours"],
      ["How was your day, {name}?", "An evening session, {name}?"],
    ],
    [
      23,
      29,
      [
        "Burning the midnight oil",
        "Still seeking at this hour",
        "The stars are out",
        "Rest well when you're done",
      ],
      ["Working late, {name}?", "Late night, {name}?"],
    ],
  ],
  byDay: [
    [
      ["Enjoy your weekend", "A quiet Sunday"],
      ["Happy Sunday, {name}", "Enjoy your weekend, {name}"],
    ],
    [[], ["Happy Monday, {name}"]],
    [[], ["Happy Tuesday, {name}"]],
    [[], ["Happy Wednesday, {name}"]],
    [[], ["Happy Thursday, {name}"]],
    [[], ["Happy Friday, {name}"]],
    [
      ["Enjoy your weekend", "A leisurely Saturday"],
      ["Happy Saturday, {name}", "Enjoy your weekend, {name}"],
    ],
  ],
};

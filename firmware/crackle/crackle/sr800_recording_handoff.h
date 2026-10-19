#pragma once

namespace sr800::recording {

inline bool canClaimPersistence(bool active, bool unsaved, bool claimed) {
  return !active && unsaved && !claimed;
}

inline bool canReadFrozenBuffer(bool active, bool claimed) {
  return !active && !claimed;
}

inline bool persistenceBlocksNewEpisode(bool meaningfulUnsaved, bool claimed) {
  return meaningfulUnsaved || claimed;
}

inline bool discardSubminimumAtHandoff(bool unsaved, bool meaningfulUnsaved,
                                       bool claimed) {
  return unsaved && !meaningfulUnsaved && !claimed;
}

}  // namespace sr800::recording

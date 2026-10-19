#include <stdint.h>

#include <cstdlib>
#include <iostream>
#include <limits>

#include "../crackle/sr800_log_retention.h"

namespace {

using sr800::retention::Archive;
using sr800::retention::Plan;
using sr800::retention::Verdict;
using sr800::retention::planLogRetention;

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

void alreadyFitsWithoutDeleting() {
  const Archive archives[] = {{1, 500, 10}};
  const Plan plan = planLogRetention(1000, 600, 200, 100, 0, archives, 1);
  require(plan.verdict == Verdict::FITS, "fitting request is accepted");
  require(plan.count == 0, "fitting request plans no deletion");
}

void deletesTheMinimumOldestPrefix() {
  const Archive archives[] = {
      {30, 100, 10},
      {10, 20, 30},
      {20, 40, 20},
  };
  const Plan plan = planLogRetention(100, 100, 50, 0, 0, archives, 3);
  require(plan.verdict == Verdict::DELETE_ARCHIVES,
          "space can be reclaimed");
  require(plan.count == 2, "only the needed oldest prefix is selected");
  require(plan.ids[0] == 10 && plan.ids[1] == 20,
          "archives are selected oldest first");
}

void excludesTheProtectedArchive() {
  const Archive archives[] = {
      {99, 100, 100},
      {20, 60, 20},
  };
  const Plan plan = planLogRetention(100, 100, 50, 0, 99, archives, 2);
  require(plan.verdict == Verdict::DELETE_ARCHIVES,
          "unprotected archive can satisfy request");
  require(plan.count == 1 && plan.ids[0] == 20,
          "protected current archive is never selected");
}

void impossiblePlansExposeNoPartialDeletion() {
  const Archive archives[] = {
      {10, 20, 30},
      {20, 20, 20},
  };
  const Plan plan = planLogRetention(100, 100, 50, 0, 0, archives, 2);
  require(plan.verdict == Verdict::IMPOSSIBLE,
          "insufficient candidates are rejected");
  require(plan.count == 0, "impossible plan exposes no partial deletion");
}

void exactlySixtyFourDeletionsCanSucceed() {
  Archive archives[64] = {};
  for (uint32_t i = 0; i < 64; ++i) {
    archives[i] = {i + 1, 1, 64 - i};
  }
  const Plan plan = planLogRetention(100, 100, 64, 0, 0, archives, 64);
  require(plan.verdict == Verdict::DELETE_ARCHIVES,
          "exactly 64 deletions are supported");
  require(plan.count == 64, "all 64 required archives are planned");
}

void sixtyFiveRequiredDeletionsAreRejectedAtomically() {
  Archive archives[65] = {};
  for (uint32_t i = 0; i < 65; ++i) {
    archives[i] = {i + 1, 1, 65 - i};
  }
  const Plan plan = planLogRetention(100, 100, 65, 0, 0, archives, 65);
  require(plan.verdict == Verdict::IMPOSSIBLE,
          "more than 64 deletions are rejected");
  require(plan.count == 0, "over-limit plan exposes no deletion");
}

void requiredSpaceArithmeticDoesNotOverflow() {
  const Archive archives[] = {{1, 1, 1}};
  const uint32_t maximum = std::numeric_limits<uint32_t>::max();
  const Plan plan =
      planLogRetention(maximum, maximum, maximum, 1, 0, archives, 1);
  require(plan.verdict == Verdict::IMPOSSIBLE,
          "wide arithmetic does not report wrapped request as fitting");
  require(plan.count == 0, "overflow case exposes no deletion");
}

void tiesAreDeterministicAndDuplicateIdsAreIgnored() {
  const Archive archives[] = {
      {20, 10, 7},
      {10, 10, 7},
      {10, 10, 6},
      {30, 10, 5},
  };
  const Plan plan = planLogRetention(100, 100, 25, 0, 0, archives, 4);
  require(plan.verdict == Verdict::DELETE_ARCHIVES,
          "tie case can reclaim space");
  require(plan.count == 3, "duplicate archive id is not selected twice");
  require(plan.ids[0] == 10 && plan.ids[1] == 20 && plan.ids[2] == 30,
          "equal ages use archive id as a stable tie-breaker");
}

void nullArchiveListCannotReclaimSpace() {
  const Plan plan = planLogRetention(100, 100, 1, 0, 0, nullptr, 10);
  require(plan.verdict == Verdict::IMPOSSIBLE,
          "null candidate list is rejected safely");
  require(plan.count == 0, "null candidate list plans no deletion");
}

}  // namespace

int main() {
  alreadyFitsWithoutDeleting();
  deletesTheMinimumOldestPrefix();
  excludesTheProtectedArchive();
  impossiblePlansExposeNoPartialDeletion();
  exactlySixtyFourDeletionsCanSucceed();
  sixtyFiveRequiredDeletionsAreRejectedAtomically();
  requiredSpaceArithmeticDoesNotOverflow();
  tiesAreDeterministicAndDuplicateIdsAreIgnored();
  nullArchiveListCannotReclaimSpace();
  std::cout << "log retention tests passed\n";
  return 0;
}

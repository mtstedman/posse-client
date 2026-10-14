// Official PHARs keep PHPUnit's dependencies isolated from SCIP and the app.
// Newest supported PHP first. Downloads are immutable and checksum-pinned.
export const PHPUNIT_RELEASES = Object.freeze([
  Object.freeze({ version: "12.5.39", minPhp: "8.3.0", sha256: "cf9a68e3e294257fac2da235c2dcfef29efd90462cafd67941ef32f52142dfce" }),
  Object.freeze({ version: "11.5.57", minPhp: "8.2.0", sha256: "c704fdd37c6c6ab7adb386f31b4e186cd51156801fa9028b5ea8099a2cd7f106" }),
  Object.freeze({ version: "10.5.66", minPhp: "8.1.0", sha256: "42bcac97bbf9fb1aecf5a7d6a1b37123a11e7e295458978f0e268999f6d9e50f" }),
]);

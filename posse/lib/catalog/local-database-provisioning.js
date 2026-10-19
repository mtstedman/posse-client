// System provisioning is a closed command set, separate from application
// package managers. Package repositories and existing server config stay owned
// by the operator. Debian needs a configured repository providing mysql-server.
export const LOCAL_DATABASE_PLATFORMS = Object.freeze(["ubuntu", "debian"]);
export const LOCAL_DATABASE_ENGINES = Object.freeze({
  postgres: { package: "postgresql", service: "postgresql", port: 5432, client: "/usr/bin/psql" },
  mysql: { package: "mysql-server", service: "mysql", port: 3306, client: "/usr/bin/mysql" },
});
export const LOCAL_DATABASE_COMMANDS = Object.freeze({
  apt: "/usr/bin/apt-get", dpkg: "/usr/bin/dpkg-query", sudo: "/usr/bin/sudo", true: "/usr/bin/true",
  systemctl: "/usr/bin/systemctl", service: "/usr/sbin/service", runuser: "/usr/sbin/runuser", env: "/usr/bin/env",
});
export const LOCAL_DATABASE_COMMAND_ENV = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", DEBIAN_FRONTEND: "noninteractive", PGPASSFILE: "/dev/null", MYSQL_TEST_LOGIN_FILE: "/dev/null" });
export const LOCAL_DATABASE_PROVISION_TIMEOUT_MS = 8 * 60_000;

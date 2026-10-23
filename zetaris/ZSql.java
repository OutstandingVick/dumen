// Runs Lightning SQL statements over JDBC (the Zetaris HTTP API only accepts SELECT).
// Credentials come from env vars, never arguments. Stops at the first real error;
// "already exists" counts as done so setup can be re-run.
// Usage: java -cp <zetaris-driver.jar> ZSql.java "<statement>" ["<statement>" ...]
import java.sql.*;
import java.util.Properties;

public class ZSql {
    public static void main(String[] args) throws Exception {
        Class.forName("com.zetaris.lightning.jdbc.LightningDriver");
        Properties p = new Properties();
        p.setProperty("user", System.getenv("ZETARIS_USER"));
        p.setProperty("password", System.getenv("ZETARIS_PASSWORD"));
        String url = System.getenv().getOrDefault("ZETARIS_JDBC_URL", "jdbc:zetaris:lightning@localhost:10000");
        DriverManager.setLoginTimeout(30);
        try (Connection c = DriverManager.getConnection(url, p)) {
            for (String sql : args) {
                String label = sql.replaceAll("\\s+", " ").replaceAll("(?i)(password\\s+\")[^\"]*", "$1***");
                label = label.substring(0, Math.min(90, label.length()));
                try (Statement s = c.createStatement()) {
                    s.setQueryTimeout(120);
                    s.execute(sql);
                    System.out.println("ok       " + label);
                } catch (SQLException e) {
                    String msg = e.getMessage().lines().findFirst().orElse("");
                    if (msg.toLowerCase().contains("already exist")) {
                        System.out.println("exists   " + label);
                        continue;
                    }
                    System.out.println("FAILED   " + label + "\n         " + msg);
                    System.exit(1);
                }
            }
        }
    }
}

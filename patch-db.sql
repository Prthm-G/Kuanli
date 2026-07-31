ALTER TABLE contacts ADD COLUMN IF NOT EXISTS roll_number TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS university TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intake_year TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intake_session TEXT;

CREATE SEQUENCE IF NOT EXISTS student_roll_seq START 1;
CREATE SEQUENCE IF NOT EXISTS temp_lead_seq START 1;

CREATE OR REPLACE FUNCTION generate_temp_lead_id() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.roll_number IS NULL THEN
        NEW.roll_number := 'LD-' || TO_CHAR(NOW(), 'YYMM') || '-' || LPAD(nextval('temp_lead_seq')::text, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_generate_temp_lead ON contacts;
CREATE TRIGGER trigger_generate_temp_lead BEFORE INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION generate_temp_lead_id();

CREATE OR REPLACE FUNCTION generate_roll_number() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.university IS NOT NULL AND OLD.university IS NULL THEN
        NEW.roll_number := 'D' || NEW.university || NEW.intake_year || NEW.intake_session || LPAD(nextval('student_roll_seq')::text, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_generate_roll_number ON contacts;
CREATE TRIGGER trigger_generate_roll_number BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION generate_roll_number();

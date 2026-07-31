const fs = require('fs');
const file = 'src/components/inbox/contact-sidebar.tsx';
let code = fs.readFileSync(file, 'utf8');

const nameReplacement = '{displayName} {(contact as any).roll_number ? ` — ${(contact as any).roll_number}` : ""}';
code = code.replace('{displayName}', nameReplacement);

const searchStr = `                ))
              )}
            </div>
          </div>

          {/* Divider */}`;

const newBlock = `                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Enrollment Setup */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span className="h-3 w-3">🎓</span>
              University Enrollment
            </div>
            {!(contact as any).university ? (
              <div className="mt-2 space-y-2 rounded-lg bg-muted p-3">
                <select id="uni-select" className="w-full text-sm bg-background p-1.5 rounded border border-border">
                  <option value="LPU">Lovely Professional University (LPU)</option>
                  <option value="CU">Chandigarh University (CU)</option>
                  <option value="AMI">Amity University (AMI)</option>
                </select>
                <div className="flex gap-2">
                  <select id="year-select" className="w-1/2 text-sm bg-background p-1.5 rounded border border-border">
                    <option value="26">2026</option>
                    <option value="27">2027</option>
                  </select>
                  <select id="intake-select" className="w-1/2 text-sm bg-background p-1.5 rounded border border-border">
                    <option value="J">July Intake (J)</option>
                    <option value="A">August Intake (A)</option>
                  </select>
                </div>
                <button onClick={async () => {
                  const u = document.getElementById('uni-select').value;
                  const y = document.getElementById('year-select').value;
                  const i = document.getElementById('intake-select').value;
                  const { createClient } = await import('@/utils/supabase/client');
                  const supabase = createClient();
                  await supabase.from('contacts').update({ university: u, intake_year: y, intake_session: i }).eq('id', contact.id);
                  window.location.reload();
                }} className="mt-2 w-full bg-primary text-primary-foreground py-1.5 rounded text-sm font-medium hover:bg-primary/90 transition-colors">
                  Generate Roll Number
                </button>
              </div>
            ) : (
              <div className="mt-2 rounded-lg bg-primary/10 p-3 text-sm border border-primary/20">
                <p className="font-bold text-primary tracking-wide text-lg">{(contact as any).roll_number}</p>
                <p className="text-xs text-muted-foreground mt-1">{(contact as any).university} • 20{(contact as any).intake_year} • Intake {(contact as any).intake_session}</p>
              </div>
            )}
          </div>

          {/* Divider */}`;

code = code.replace(searchStr, newBlock);
fs.writeFileSync(file, code);
console.log("UI Successfully Hacked!");

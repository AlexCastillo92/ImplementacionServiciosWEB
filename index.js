// index.js
const http = require("http");
const express = require("express");
const cors = require("cors");
const soap = require("soap");

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// Datos en memoria (mock)
// ---------------------------
let reservas = []; // { id, clienteId, sucursalId, fecha, hora, personas, estado }
let nextId = 1;

const mesasPorSucursal = {
  S01: [{ id: "M1", capacidad: 2 }, { id: "M2", capacidad: 4 }, { id: "M3", capacidad: 4 }],
  S02: [{ id: "M1", capacidad: 2 }, { id: "M2", capacidad: 2 }]
};

// ---------------------------
// REST básico
// ---------------------------

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Disponibilidad simple (regresa cuántas mesas hay por sucursal)
app.get("/disponibilidad", (req, res) => {
  const { sucursal } = req.query;
  if (!sucursal || !mesasPorSucursal[sucursal]) {
    return res.status(400).json({ error: "Parámetro 'sucursal' inválido o faltante (e.g. S01)" });
  }

  // Demo simple: “disponibles” = todas las mesas menos las reservadas justo a esa hora
  const { fecha, hora, personas } = req.query;
  const capNecesaria = parseInt(personas || "1", 10);

  const mesas = mesasPorSucursal[sucursal] || [];
  const ocupadas = reservas.filter(r =>
    r.sucursalId === sucursal && r.fecha === fecha && r.hora === hora
  ).map(r => r.mesaId);

  const disponibles = mesas.filter(m => !ocupadas.includes(m.id) && m.capacidad >= capNecesaria);

  res.json({
    sucursal,
    fecha: fecha || "(no especificada)",
    hora: hora || "(no especificada)",
    solicitadasPersonas: capNecesaria,
    disponibles
  });
});

// Crea reserva (REST puro) — sin pago ni notificaciones
app.post("/reservas", (req, res) => {
  const { clienteId, sucursalId, fecha, hora, personas } = req.body;
  if (!clienteId || !sucursalId || !fecha || !hora || !personas) {
    return res.status(400).json({ error: "Faltan campos: clienteId, sucursalId, fecha, hora, personas" });
  }

  // asigna primera mesa que alcance
  const mesa = (mesasPorSucursal[sucursalId] || []).find(m => m.capacidad >= Number(personas));
  if (!mesa) return res.status(409).json({ error: "No hay mesa con capacidad suficiente" });

  // verifica que no esté ocupada a esa hora
  const yaOcupada = reservas.some(r =>
    r.sucursalId === sucursalId && r.fecha === fecha && r.hora === hora && r.mesaId === mesa.id
  );
  if (yaOcupada) return res.status(409).json({ error: "Mesa ocupada en ese horario" });

  const nueva = {
    id: String(nextId++),
    clienteId,
    sucursalId,
    fecha,
    hora,
    personas: Number(personas),
    mesaId: mesa.id,
    estado: "CREADA"
  };
  reservas.push(nueva);
  res.status(201).json({ reservaId: nueva.id, estado: nueva.estado });
});

// Obtiene una reserva
app.get("/reservas/:id", (req, res) => {
  const r = reservas.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "No encontrada" });
  res.json(r);
});

// Cancela una reserva
app.delete("/reservas/:id", (req, res) => {
  const idx = reservas.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "No encontrada" });
  reservas[idx].estado = "CANCELADA";
  res.json({ ok: true, estado: "CANCELADA" });
});

// ---------------------------
/** SOAP súper simple (SOA):
 *  - Operación CrearReservaSOAP(clienteId, sucursalId, fecha, hora, personas)
 *  - Respuesta: { reservaId, estado }
 */
// ---------------------------

// WSDL minimal (suficiente para SoapUI/Postman)
const wsdl = `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="ReservasService"
  targetNamespace="http://ejemplo.com/reservas"
  xmlns:tns="http://ejemplo.com/reservas"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">

  <types>
    <xsd:schema targetNamespace="http://ejemplo.com/reservas">
      <xsd:element name="CrearReservaRequest">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="clienteId" type="xsd:string"/>
            <xsd:element name="sucursalId" type="xsd:string"/>
            <xsd:element name="fecha" type="xsd:string"/>
            <xsd:element name="hora" type="xsd:string"/>
            <xsd:element name="personas" type="xsd:int"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="CrearReservaResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="reservaId" type="xsd:string"/>
            <xsd:element name="estado" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </types>

  <message name="CrearReservaInput">
    <part name="parameters" element="tns:CrearReservaRequest"/>
  </message>
  <message name="CrearReservaOutput">
    <part name="parameters" element="tns:CrearReservaResponse"/>
  </message>

  <portType name="ReservasPortType">
    <operation name="CrearReserva">
      <input message="tns:CrearReservaInput"/>
      <output message="tns:CrearReservaOutput"/>
    </operation>
  </portType>

  <binding name="ReservasBinding" type="tns:ReservasPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="CrearReserva">
      <soap:operation soapAction="CrearReserva"/>
      <input>
        <soap:body use="literal"/>
      </input>
      <output>
        <soap:body use="literal"/>
      </output>
    </operation>
  </binding>

  <service name="ReservasService">
    <port name="ReservasPort" binding="tns:ReservasBinding">
      <soap:address location="http://localhost:3000/wsdl"/>
    </port>
  </service>
</definitions>`;

// Implementación SOAP
const soapService = {
  ReservasService: {
    ReservasPort: {
      CrearReserva: function (args) {
        const { clienteId, sucursalId, fecha, hora, personas } = args;

        // lógica mínima (misma que REST)
        const mesa = (mesasPorSucursal[sucursalId] || []).find(m => m.capacidad >= Number(personas));
        if (!mesa) {
          // En SOAP, lo simple es regresar un estado de error
          return { reservaId: "", estado: "SIN_MESA" };
        }

        const yaOcupada = reservas.some(r =>
          r.sucursalId === sucursalId && r.fecha === fecha && r.hora === hora && r.mesaId === mesa.id
        );
        if (yaOcupada) {
          return { reservaId: "", estado: "OCUPADA" };
        }

        const nueva = {
          id: String(nextId++),
          clienteId,
          sucursalId,
          fecha,
          hora,
          personas: Number(personas),
          mesaId: mesa.id,
          estado: "CREADA"
        };
        reservas.push(nueva);
        return { reservaId: nueva.id, estado: nueva.estado };
      }
    }
  }
};

// Servidor HTTP compartido (para montar Express + SOAP)
const server = http.createServer(app);

// Monta el listener SOAP en /wsdl
soap.listen(server, "/wsdl", soapService, wsdl);

// ---------------------------
// Endpoint REST que “integra” llamando al SOAP interno
// ---------------------------
app.post("/integracion/crear-reserva", async (req, res) => {
  const { clienteId, sucursalId, fecha, hora, personas } = req.body || {};
  if (!clienteId || !sucursalId || !fecha || !hora || !personas) {
    return res.status(400).json({ error: "Faltan campos" });
  }

  try {
    const url = "http://localhost:3000/wsdl?wsdl";
    const client = await soap.createClientAsync(url);
    const [resp] = await client.CrearReservaAsync({ clienteId, sucursalId, fecha, hora, personas: Number(personas) });
    return res.status(201).json(resp);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Fallo integración con SOAP" });
  }
});

// ---------------------------
// Lanzar servidor
// ---------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`REST listo en http://localhost:${PORT}`);
  console.log(`SOAP WSDL en  http://localhost:${PORT}/wsdl?wsdl`);
});

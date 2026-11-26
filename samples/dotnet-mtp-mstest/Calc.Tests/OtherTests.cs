using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Calc.Tests;

[TestClass]
public class OtherTests
{
    [TestMethod]
    public void DividesTwoNumbers()
    {
        Assert.AreEqual(2, Calculator.Divide(6, 3));
    }
}
